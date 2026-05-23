/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/resourcesExplorer.css';
import { $, addDisposableListener, append, clearNode, Dimension, disposableWindowInterval, EventType, getWindow, reset } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICPUProperties, INativeHostService, IOSProperties, IOSStatistics } from '../../../../platform/native/common/native.js';
import { IProcessService, IResolvedProcessInformation } from '../../../../platform/process/common/process.js';
import { ProcessItem } from '../../../../base/common/processes.js';
import { isRemoteDiagnosticError } from '../../../../platform/diagnostics/common/diagnostics.js';

type TabId = 'overview' | 'cpu-memory' | 'disk' | 'network';
type CategoryId = 'editor' | 'extension' | 'terminal' | 'other' | 'non-nuggetcode';

interface ICategoryInfo {
	readonly id: CategoryId;
	readonly label: string;
	readonly colorVar: string;
}

const CATEGORIES: readonly ICategoryInfo[] = [
	{ id: 'editor', label: 'Editor', colorVar: '--re-cat-editor' },
	{ id: 'extension', label: 'Extensions', colorVar: '--re-cat-extension' },
	{ id: 'terminal', label: 'Terminal', colorVar: '--re-cat-terminal' },
	{ id: 'other', label: 'Other', colorVar: '--re-cat-other' },
	{ id: 'non-nuggetcode', label: 'Non-NuggetCode', colorVar: '--re-cat-non-nuggetcode' },
];

interface IProcessRow {
	readonly name: string;
	readonly cmd: string;
	readonly pid: number;
	readonly cpu: number;
	readonly memBytes: number;
	readonly category: CategoryId;
}

interface ICategoryTotals {
	readonly cpu: number;     // percent (0..100)
	readonly memBytes: number;
}

interface ISnapshot {
	readonly stats: IOSStatistics;
	readonly props: IOSProperties;
	readonly memPercent: number;
	readonly cpuPercent: number;
	readonly processes: IProcessRow[];
	readonly totalsByCategory: Map<CategoryId, ICategoryTotals>;
	readonly online: boolean;
}

/** Categorize a single ProcessItem based on its name/cmd. */
function categorizeProcess(name: string, cmd: string): CategoryId {
	const lc = (name + ' ' + cmd).toLowerCase();
	if (lc.includes('extensionhost') || lc.includes('extension host')) {
		return 'extension';
	}
	if (lc.includes('ptyhost') || lc.includes('terminal')) {
		return 'terminal';
	}
	if (lc.includes('window') || lc.includes('main') || lc.includes('renderer') || lc.includes('gpu') || lc.includes('shared')) {
		return 'editor';
	}
	if (lc.includes('code') || lc.includes('electron') || lc.includes('nugget')) {
		return 'other';
	}
	return 'non-nuggetcode';
}

/** Flatten a process tree (root + children) into an array of rows. */
function flattenProcesses(root: ProcessItem, out: IProcessRow[]): void {
	out.push({
		name: root.name,
		cmd: root.cmd,
		pid: root.pid,
		cpu: root.load,
		memBytes: root.mem,
		category: categorizeProcess(root.name, root.cmd)
	});
	if (root.children) {
		for (const child of root.children) {
			flattenProcesses(child, out);
		}
	}
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	if (bytes < 1024 * 1024 * 1024) {
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatPercent(p: number): string {
	if (p < 0.1 && p > 0) {
		return '<0.1%';
	}
	return `${p.toFixed(1)}%`;
}

export class ResourcesExplorerControl extends Disposable {

	private static readonly REFRESH_INTERVAL_MS = 2000;

	private static readonly TABS: readonly { id: TabId; label: string }[] = [
		{ id: 'overview', label: localize('resourcesExplorer.tab.overview', "Overview") },
		{ id: 'cpu-memory', label: localize('resourcesExplorer.tab.cpuMemory', "CPU & Memory") },
		{ id: 'disk', label: localize('resourcesExplorer.tab.disk', "Disk") },
		{ id: 'network', label: localize('resourcesExplorer.tab.network', "Network") },
	];

	private readonly container: HTMLElement;
	private readonly tabButtons = new Map<TabId, HTMLButtonElement>();
	private readonly tabBodies = new Map<TabId, HTMLElement>();

	private activeTab: TabId = 'overview';
	private activeProcessFilter: CategoryId = 'editor';
	private showOnlyHighOccupancy = false;
	private currentSnapshot: ISnapshot | undefined;

	private statusBanner!: HTMLElement;
	private statusBannerIcon!: HTMLElement;
	private statusBannerText!: HTMLElement;

	// Overview tab refs
	private overviewCards: {
		cpu: { value: HTMLElement; rows: HTMLElement };
		mem: { value: HTMLElement; rows: HTMLElement };
		disk: { value: HTMLElement; subText: HTMLElement; rows: HTMLElement };
	} | undefined;

	// CPU & Memory tab refs
	private cpuPanel: { model: HTMLElement; subText: HTMLElement; bar: HTMLElement; rows: HTMLElement } | undefined;
	private memPanel: { total: HTMLElement; bar: HTMLElement; rows: HTMLElement } | undefined;
	private processSubTabs = new Map<CategoryId, HTMLButtonElement>();
	private processTable: HTMLElement | undefined;
	private highOccupancyCheckbox: HTMLInputElement | undefined;

	constructor(
		parent: HTMLElement,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IProcessService private readonly processService: IProcessService,
	) {
		super();

		this.container = append(parent, $('.resources-explorer'));
		this.buildScaffold();

		this.buildOverviewTab();
		this.buildCpuMemoryTab();
		this.buildDiskTab();
		this.buildNetworkTab();

		this.setActiveTab('overview');

		this.update();
		this._register(disposableWindowInterval(
			getWindow(parent),
			() => this.update(),
			ResourcesExplorerControl.REFRESH_INTERVAL_MS
		));
	}

	focus(): void {
		this.tabButtons.get(this.activeTab)?.focus();
	}

	layout(_dimension: Dimension): void {
		// Pure CSS layout, nothing to measure.
	}

	// --- scaffold ---

	private buildScaffold(): void {
		// Top tab strip + right-aligned auxiliary actions
		const topBar = append(this.container, $('.re-topbar'));

		const tabsBar = append(topBar, $('.re-tabs'));
		for (const tab of ResourcesExplorerControl.TABS) {
			const button = append(tabsBar, $('button.re-tab', { 'data-tab-id': tab.id, type: 'button' })) as HTMLButtonElement;
			button.textContent = tab.label;
			this.tabButtons.set(tab.id, button);
			this._register(addDisposableListener(button, EventType.CLICK, () => this.setActiveTab(tab.id)));
		}

		// Right side: "Report Issue" link (decorative; opens VS Code issue reporter)
		const topRight = append(topBar, $('.re-topbar-right'));
		const reportLink = append(topRight, $('a.re-link', { href: '#' })) as HTMLAnchorElement;
		reportLink.textContent = localize('resourcesExplorer.reportIssue', "Report Issue");

		// Status banner
		this.statusBanner = append(this.container, $('.re-status-banner'));
		this.statusBannerIcon = append(this.statusBanner, $('span.codicon.codicon-pass-filled'));
		this.statusBannerText = append(this.statusBanner, $('span.re-status-text'));
		this.statusBannerText.textContent = localize('resourcesExplorer.statusLoading', "Loading…");

		// Tab body container
		const bodies = append(this.container, $('.re-tab-bodies'));
		for (const tab of ResourcesExplorerControl.TABS) {
			const body = append(bodies, $('.re-tab-body', { 'data-tab-id': tab.id }));
			this.tabBodies.set(tab.id, body);
		}
	}

	private setActiveTab(id: TabId): void {
		this.activeTab = id;
		for (const [tabId, button] of this.tabButtons) {
			button.classList.toggle('active', tabId === id);
		}
		for (const [tabId, body] of this.tabBodies) {
			body.classList.toggle('active', tabId === id);
		}
	}

	// --- Overview tab ---

	private buildOverviewTab(): void {
		const body = this.tabBodies.get('overview')!;
		clearNode(body);

		const grid = append(body, $('.re-overview-grid'));

		const cpuCard = this.buildOverviewCard(grid, 'pulse', localize('resourcesExplorer.cpuSystem', "CPU (System)"));
		const memCard = this.buildOverviewCard(grid, 'database', localize('resourcesExplorer.memorySystem', "Memory (System)"));
		const diskCard = this.buildOverviewCard(grid, 'device-desktop', localize('resourcesExplorer.diskSystem', "Disk (System)"));

		this.overviewCards = {
			cpu: { value: cpuCard.value, rows: cpuCard.rows },
			mem: { value: memCard.value, rows: memCard.rows },
			disk: { value: diskCard.value, subText: diskCard.subText, rows: diskCard.rows },
		};
	}

	private buildOverviewCard(parent: HTMLElement, codicon: string, title: string): { value: HTMLElement; subText: HTMLElement; rows: HTMLElement } {
		const card = append(parent, $('.re-card.re-overview-card'));

		const header = append(card, $('.re-card-header'));
		append(header, $(`span.codicon.codicon-${codicon}.re-card-icon`));
		append(header, $('span.re-card-title')).textContent = title;
		append(header, $('span.codicon.codicon-chevron-right.re-card-chevron'));

		const valueRow = append(card, $('.re-card-value-row'));
		const value = append(valueRow, $('.re-card-value'));
		value.textContent = '-';
		const subText = append(valueRow, $('.re-card-subtext'));
		subText.textContent = '';

		append(card, $('.re-card-section-label')).textContent = localize('resourcesExplorer.nuggetUsage', "NuggetCode usage");

		const rows = append(card, $('.re-card-rows'));
		return { value, subText, rows };
	}

	// --- CPU & Memory tab ---

	private buildCpuMemoryTab(): void {
		const body = this.tabBodies.get('cpu-memory')!;
		clearNode(body);

		const split = append(body, $('.re-split'));
		const left = append(split, $('.re-split-left'));
		const right = append(split, $('.re-split-right'));

		// CPU panel
		const cpuPanel = append(left, $('.re-card'));
		const cpuHeader = append(cpuPanel, $('.re-detail-header'));
		append(cpuHeader, $('span.codicon.codicon-pulse'));
		append(cpuHeader, $('span.re-detail-title')).textContent = localize('resourcesExplorer.cpuProcessor', "CPU Processor");
		const cpuModel = append(cpuPanel, $('.re-detail-subtext'));
		cpuModel.textContent = '-';
		const cpuBar = append(append(cpuPanel, $('.re-bar-track')), $('.re-bar-fill'));
		const cpuRows = append(cpuPanel, $('.re-card-rows'));
		this.cpuPanel = { model: cpuModel, subText: cpuModel, bar: cpuBar, rows: cpuRows };

		// Memory panel
		const memPanel = append(left, $('.re-card'));
		const memHeader = append(memPanel, $('.re-detail-header'));
		append(memHeader, $('span.codicon.codicon-database'));
		append(memHeader, $('span.re-detail-title')).textContent = localize('resourcesExplorer.physicalMemory', "Physical Memory");
		const memTotal = append(memPanel, $('.re-detail-subtext'));
		memTotal.textContent = '-';
		const memBar = append(append(memPanel, $('.re-bar-track')), $('.re-bar-fill'));
		const memRows = append(memPanel, $('.re-card-rows'));
		this.memPanel = { total: memTotal, bar: memBar, rows: memRows };

		// Right: sub-tabs + process table
		const subTabsBar = append(right, $('.re-subtabs'));
		for (const cat of CATEGORIES) {
			if (cat.id === 'non-nuggetcode') {
				continue; // process table only shows NuggetCode-managed processes
			}
			const subTab = append(subTabsBar, $('button.re-subtab', { 'data-cat': cat.id, type: 'button' })) as HTMLButtonElement;
			subTab.textContent = cat.label;
			this.processSubTabs.set(cat.id, subTab);
			this._register(addDisposableListener(subTab, EventType.CLICK, () => {
				this.activeProcessFilter = cat.id;
				this.updateProcessSubTabs();
				this.renderProcessTable();
			}));
		}

		// "Show only high occupancy" checkbox
		const subTabsRight = append(subTabsBar, $('.re-subtabs-right'));
		const checkboxLabel = append(subTabsRight, $('label.re-checkbox-label'));
		this.highOccupancyCheckbox = append(checkboxLabel, $('input', { type: 'checkbox' })) as HTMLInputElement;
		append(checkboxLabel, $('span')).textContent = localize('resourcesExplorer.showHighOccupancy', "Show only high occupancy");
		this._register(addDisposableListener(this.highOccupancyCheckbox, EventType.CHANGE, () => {
			this.showOnlyHighOccupancy = !!this.highOccupancyCheckbox!.checked;
			this.renderProcessTable();
		}));

		// Process table header
		const tableWrap = append(right, $('.re-table-wrap'));
		const tableHeader = append(tableWrap, $('.re-table-header'));
		append(tableHeader, $('.re-th.re-th-name')).textContent = localize('resourcesExplorer.processName', "Process Name");
		const cpuTh = append(tableHeader, $('.re-th.re-th-cpu'));
		cpuTh.textContent = localize('resourcesExplorer.cpuPercent', "% CPU");
		append(cpuTh, $('span.codicon.codicon-arrow-down'));
		append(tableHeader, $('.re-th.re-th-mem')).textContent = localize('resourcesExplorer.physicalMemoryShort', "Physical Memory");
		append(tableHeader, $('.re-th.re-th-pid')).textContent = 'PID';

		// Process rows
		this.processTable = append(tableWrap, $('.re-table-body'));

		this.updateProcessSubTabs();
	}

	private updateProcessSubTabs(): void {
		for (const [cat, button] of this.processSubTabs) {
			button.classList.toggle('active', cat === this.activeProcessFilter);
		}
	}

	private renderProcessTable(): void {
		if (!this.processTable || !this.currentSnapshot) {
			return;
		}
		clearNode(this.processTable);

		let filtered = this.currentSnapshot.processes.filter(p => p.category === this.activeProcessFilter);
		if (this.showOnlyHighOccupancy) {
			filtered = filtered.filter(p => p.cpu > 1 || p.memBytes > 100 * 1024 * 1024);
		}
		// Sort by CPU desc
		filtered = filtered.slice().sort((a, b) => b.cpu - a.cpu);

		if (filtered.length === 0) {
			const empty = append(this.processTable, $('.re-empty-row'));
			empty.textContent = localize('resourcesExplorer.noProcesses', "No processes in this category.");
			return;
		}

		for (const proc of filtered) {
			const row = append(this.processTable, $('.re-tr'));
			const nameCell = append(row, $('.re-td.re-td-name'));
			append(nameCell, $('span.codicon.codicon-server-process.re-row-icon'));
			append(nameCell, $('span.re-row-name')).textContent = proc.name;
			append(nameCell, $('span.re-row-cmd')).textContent = proc.cmd.length > 50 ? proc.cmd.substring(0, 50) + '…' : proc.cmd;

			append(row, $('.re-td.re-td-cpu')).textContent = proc.cpu.toFixed(1);
			append(row, $('.re-td.re-td-mem')).textContent = formatBytes(proc.memBytes);
			append(row, $('.re-td.re-td-pid')).textContent = String(proc.pid);
		}
	}

	// --- Disk tab ---

	private diskPanel: { name: HTMLElement; bar: HTMLElement; rows: HTMLElement } | undefined;
	private diskDetailCards: HTMLElement | undefined;

	private buildDiskTab(): void {
		const body = this.tabBodies.get('disk')!;
		clearNode(body);

		const split = append(body, $('.re-split'));
		const left = append(split, $('.re-split-left'));
		const right = append(split, $('.re-split-right'));

		// Disk panel
		const panel = append(left, $('.re-card'));
		const header = append(panel, $('.re-detail-header'));
		append(header, $('span.codicon.codicon-device-desktop'));
		append(header, $('span.re-detail-title')).textContent = localize('resourcesExplorer.disk', "Disk");
		const name = append(panel, $('.re-detail-subtext'));
		name.textContent = '-';
		const bar = append(append(panel, $('.re-bar-track')), $('.re-bar-fill'));
		const rows = append(panel, $('.re-card-rows'));
		this.diskPanel = { name, bar, rows };

		// Right: detail cards
		this.diskDetailCards = append(right, $('.re-disk-detail-cards'));
		this.buildDiskDetailCard(this.diskDetailCards, 'file', localize('resourcesExplorer.logFiles', "Log Files"), '- MB');
		this.buildDiskDetailCard(this.diskDetailCards, 'database', localize('resourcesExplorer.cacheStorage', "Cache Storage"), '- MB');
		this.buildDiskDetailCard(this.diskDetailCards, 'folder', localize('resourcesExplorer.others', "Others"), '- MB');
	}

	private buildDiskDetailCard(parent: HTMLElement, codicon: string, name: string, size: string): void {
		const card = append(parent, $('.re-disk-detail-card'));
		append(card, $(`span.codicon.codicon-${codicon}.re-disk-icon`));
		const info = append(card, $('.re-disk-info'));
		append(info, $('.re-disk-name')).textContent = name;
		append(info, $('.re-disk-size')).textContent = size;
		append(card, $('span.codicon.codicon-chevron-right.re-disk-chevron'));
	}

	// --- Network tab ---

	private networkSections: HTMLElement | undefined;
	private networkLastDiagnosed: HTMLElement | undefined;
	private networkOnlineIndicator: HTMLElement | undefined;

	private buildNetworkTab(): void {
		const body = this.tabBodies.get('network')!;
		clearNode(body);

		// Diagnose button + last diagnosed timestamp
		const topRow = append(body, $('.re-network-toprow'));
		const diagnoseBtn = append(topRow, $('button.re-button', { type: 'button' })) as HTMLButtonElement;
		diagnoseBtn.textContent = localize('resourcesExplorer.diagnoseNetwork', "Diagnose Network");
		this.networkLastDiagnosed = append(topRow, $('.re-network-lastdiag'));
		this.networkLastDiagnosed.textContent = '';

		this._register(addDisposableListener(diagnoseBtn, EventType.CLICK, () => {
			this.networkLastDiagnosed!.textContent = localize('resourcesExplorer.lastDiagnosed', "Last Diagnosed: {0}", new Date().toLocaleTimeString());
		}));

		// Sections
		this.networkSections = append(body, $('.re-network-sections'));

		// Section 1: Connectivity
		const connectivity = this.buildCollapsibleSection(this.networkSections, localize('resourcesExplorer.connectivity', "Connectivity"), true);
		const connBody = connectivity.body;
		const statusRow = append(connBody, $('.re-detail-row'));
		append(statusRow, $('span.re-key')).textContent = localize('resourcesExplorer.networkStatus', "Network status:");
		this.networkOnlineIndicator = append(statusRow, $('span.re-value'));
		this.networkOnlineIndicator.textContent = '-';

		// Section 2: Firewall
		const firewall = this.buildCollapsibleSection(this.networkSections, localize('resourcesExplorer.firewall', "Firewall Detection"), false);
		const fwRow = append(firewall.body, $('.re-detail-row'));
		fwRow.textContent = localize('resourcesExplorer.firewallNote', "Firewall detection runs on the system level. Click Diagnose Network to refresh.");

		// Section 3: Hardware
		const hw = this.buildCollapsibleSection(this.networkSections, localize('resourcesExplorer.networkHardware', "Network Hardware Info"), false);
		const hwRow = append(hw.body, $('.re-detail-row'));
		hwRow.textContent = localize('resourcesExplorer.hardwareNote', "Hardware details require deeper system access (coming in a future update).");
	}

	private buildCollapsibleSection(parent: HTMLElement, title: string, expanded: boolean): { header: HTMLElement; body: HTMLElement } {
		const section = append(parent, $('.re-collapsible'));
		section.classList.toggle('expanded', expanded);

		const header = append(section, $('.re-collapsible-header'));
		append(header, $('span.codicon.codicon-pass-filled.re-collapsible-status'));
		append(header, $('span.re-collapsible-title')).textContent = title;
		append(header, $('span.codicon.codicon-chevron-down.re-collapsible-chevron'));

		const body = append(section, $('.re-collapsible-body'));

		this._register(addDisposableListener(header, EventType.CLICK, () => {
			section.classList.toggle('expanded');
		}));

		return { header, body };
	}

	// --- live data ---

	private async update(): Promise<void> {
		try {
			const [stats, props, procInfo] = await Promise.all([
				this.nativeHostService.getOSStatistics(),
				this.nativeHostService.getOSProperties(),
				this.processService.resolveProcesses().catch((): IResolvedProcessInformation => ({ pidToNames: [], processes: [] }))
			]);

			const memPercent = Math.round(((stats.totalmem - stats.freemem) / stats.totalmem) * 100);
			const cpuCount = props.cpus?.length || 1;
			const load = stats.loadavg?.[0] ?? 0;
			const cpuPercent = Math.max(0, Math.min(100, Math.round((load / cpuCount) * 100)));

			// Flatten all process trees (skip remote-diagnostic-error entries)
			const flat: IProcessRow[] = [];
			for (const machine of procInfo.processes) {
				if (!isRemoteDiagnosticError(machine.rootProcess)) {
					flattenProcesses(machine.rootProcess, flat);
				}
			}

			// Aggregate by category
			const totals = new Map<CategoryId, ICategoryTotals>();
			for (const cat of CATEGORIES) {
				totals.set(cat.id, { cpu: 0, memBytes: 0 });
			}
			for (const p of flat) {
				const t = totals.get(p.category)!;
				totals.set(p.category, { cpu: t.cpu + p.cpu, memBytes: t.memBytes + p.memBytes });
			}
			// Non-NuggetCode total = system - NuggetCode-managed
			const nuggetMemBytes = (totals.get('editor')!.memBytes + totals.get('extension')!.memBytes + totals.get('terminal')!.memBytes + totals.get('other')!.memBytes);
			totals.set('non-nuggetcode', {
				cpu: Math.max(0, cpuPercent - (totals.get('editor')!.cpu + totals.get('extension')!.cpu + totals.get('terminal')!.cpu + totals.get('other')!.cpu)),
				memBytes: Math.max(0, (stats.totalmem - stats.freemem) - nuggetMemBytes)
			});

			this.currentSnapshot = {
				stats, props, memPercent, cpuPercent,
				processes: flat,
				totalsByCategory: totals,
				online: navigator.onLine
			};

			this.renderAll();
		} catch {
			// Keep last-known data on transient failures.
		}
	}

	private renderAll(): void {
		const snap = this.currentSnapshot;
		if (!snap) { return; }

		this.renderStatusBanner(snap);
		this.renderOverview(snap);
		this.renderCpuMemory(snap);
		this.renderDisk(snap);
		this.renderNetwork(snap);
	}

	private renderStatusBanner(snap: ISnapshot): void {
		const high = snap.memPercent >= 90 || snap.cpuPercent >= 90;
		this.statusBanner.classList.toggle('warning', high);
		this.statusBannerIcon.className = high ? 'codicon codicon-warning' : 'codicon codicon-pass-filled';
		this.statusBannerText.textContent = high
			? localize('resourcesExplorer.statusHigh', "High resource usage detected.")
			: localize('resourcesExplorer.statusOk', "The system has not yet detected any high resource usage.");
	}

	private renderOverview(snap: ISnapshot): void {
		if (!this.overviewCards) { return; }

		this.overviewCards.cpu.value.textContent = `${snap.cpuPercent}%`;
		this.overviewCards.mem.value.textContent = `${snap.memPercent}%`;
		this.overviewCards.disk.value.textContent = '-';
		this.overviewCards.disk.subText.textContent = localize('resourcesExplorer.diskAvailableUnknown', "Disk stats coming soon");

		this.renderCategoryRows(this.overviewCards.cpu.rows, snap, 'cpu');
		this.renderCategoryRows(this.overviewCards.mem.rows, snap, 'mem');
		this.renderDiskCategoryRows(this.overviewCards.disk.rows);
	}

	private renderCategoryRows(parent: HTMLElement, snap: ISnapshot, kind: 'cpu' | 'mem'): void {
		clearNode(parent);
		for (const cat of CATEGORIES) {
			const totals = snap.totalsByCategory.get(cat.id)!;
			const row = append(parent, $('.re-cat-row'));
			const dot = append(row, $('span.re-cat-dot')) as HTMLElement;
			dot.style.background = `var(${cat.colorVar})`;
			append(row, $('span.re-cat-label')).textContent = cat.label;
			const value = append(row, $('span.re-cat-value'));
			value.textContent = kind === 'cpu' ? formatPercent(totals.cpu) : formatBytes(totals.memBytes);
		}
	}

	private renderDiskCategoryRows(parent: HTMLElement): void {
		clearNode(parent);
		const sections = [
			{ label: localize('resourcesExplorer.logFiles', "Log Files"), value: '- MB', colorVar: '--re-cat-editor' },
			{ label: localize('resourcesExplorer.cacheStorage', "Cache Storage"), value: '- MB', colorVar: '--re-cat-extension' },
			{ label: localize('resourcesExplorer.others', "Others"), value: '- MB', colorVar: '--re-cat-other' },
		];
		for (const s of sections) {
			const row = append(parent, $('.re-cat-row'));
			const dot = append(row, $('span.re-cat-dot')) as HTMLElement;
			dot.style.background = `var(${s.colorVar})`;
			append(row, $('span.re-cat-label')).textContent = s.label;
			append(row, $('span.re-cat-value')).textContent = s.value;
		}
	}

	private renderCpuMemory(snap: ISnapshot): void {
		if (this.cpuPanel) {
			const firstCpu: ICPUProperties | undefined = snap.props.cpus?.[0];
			const model = firstCpu?.model?.trim() || localize('resourcesExplorer.unknownCpu', "Unknown CPU");
			const cores = snap.props.cpus?.length ?? 0;
			const speedMHz = firstCpu?.speed ?? 0;
			this.cpuPanel.model.textContent = `${model} (${cores} × ${speedMHz})`;
			this.cpuPanel.bar.style.width = `${snap.cpuPercent}%`;
			this.renderCategoryRows(this.cpuPanel.rows, snap, 'cpu');
		}
		if (this.memPanel) {
			const totalGB = (snap.stats.totalmem / (1024 ** 3)).toFixed(0);
			this.memPanel.total.textContent = `${totalGB}GB`;
			this.memPanel.bar.style.width = `${snap.memPercent}%`;
			this.renderCategoryRows(this.memPanel.rows, snap, 'mem');
		}
		this.renderProcessTable();
	}

	private renderDisk(snap: ISnapshot): void {
		if (this.diskPanel) {
			const firstCpu = snap.props.cpus?.[0];
			this.diskPanel.name.textContent = firstCpu?.model?.trim() ?? '-';
			this.diskPanel.bar.style.width = '12%';  // stub
			this.renderDiskCategoryRows(this.diskPanel.rows);
		}
	}

	private renderNetwork(snap: ISnapshot): void {
		if (this.networkOnlineIndicator) {
			this.networkOnlineIndicator.textContent = snap.online
				? localize('resourcesExplorer.online', "Online")
				: localize('resourcesExplorer.offline', "Offline");
			this.networkOnlineIndicator.classList.toggle('re-value-good', snap.online);
			this.networkOnlineIndicator.classList.toggle('re-value-bad', !snap.online);
		}
	}
}
