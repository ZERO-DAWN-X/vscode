/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/resourcesExplorer.css';
import { $, addDisposableListener, append, clearNode, Dimension, disposableWindowInterval, EventType, getWindow, reset } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICPUProperties, INativeHostService, IOSProperties, IOSStatistics } from '../../../../platform/native/common/native.js';

type TabId = 'overview' | 'cpu-memory' | 'disk' | 'network';

interface ITabDescriptor {
	readonly id: TabId;
	readonly label: string;
}

interface ISnapshot {
	stats: IOSStatistics;
	props: IOSProperties;
	cpuPercent: number; // approximated from loadavg / cpu count
	memPercent: number;
	online: boolean;
}

/**
 * The actual Resources Explorer UI. Owns the tab strip, the status banner,
 * the four tab bodies, and the polling loop that refreshes live data.
 *
 * The DOM is built once on construction; subsequent updates only mutate
 * leaf text nodes via the `update*` methods rather than re-rendering, so
 * the layout doesn't flicker on each tick.
 */
export class ResourcesExplorerControl extends Disposable {

	private static readonly REFRESH_INTERVAL_MS = 2000;

	private static readonly TABS: readonly ITabDescriptor[] = [
		{ id: 'overview', label: localize('resourcesExplorer.tab.overview', "Overview") },
		{ id: 'cpu-memory', label: localize('resourcesExplorer.tab.cpuMemory', "CPU & Memory") },
		{ id: 'disk', label: localize('resourcesExplorer.tab.disk', "Disk") },
		{ id: 'network', label: localize('resourcesExplorer.tab.network', "Network") },
	];

	private readonly container: HTMLElement;
	private readonly tabButtons = new Map<TabId, HTMLButtonElement>();
	private readonly tabBodies = new Map<TabId, HTMLElement>();

	private activeTab: TabId = 'overview';
	private currentSnapshot: ISnapshot | undefined;

	private statusBanner!: HTMLElement;
	private statusBannerIcon!: HTMLElement;
	private statusBannerText!: HTMLElement;

	constructor(
		parent: HTMLElement,
		@INativeHostService private readonly nativeHostService: INativeHostService,
	) {
		super();

		this.container = append(parent, $('.resources-explorer'));
		this.buildScaffold();

		// Build each tab body once; updates mutate text in place.
		this.buildOverviewTab();
		this.buildCpuMemoryTab();
		this.buildDiskTab();
		this.buildNetworkTab();

		this.setActiveTab('overview');

		// Initial fetch + recurring poll.
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
		// Pure CSS layout — no measurement needed.
	}

	// --- scaffold ---

	private buildScaffold(): void {
		// Tab strip
		const tabsBar = append(this.container, $('.re-tabs'));
		for (const tab of ResourcesExplorerControl.TABS) {
			const button = append(tabsBar, $('button.re-tab', { 'data-tab-id': tab.id, type: 'button' })) as HTMLButtonElement;
			button.textContent = tab.label;
			this.tabButtons.set(tab.id, button);
			this._register(addDisposableListener(button, EventType.CLICK, () => this.setActiveTab(tab.id)));
		}

		// Status banner: green/yellow/red depending on highest resource %.
		this.statusBanner = append(this.container, $('.re-status-banner'));
		this.statusBannerIcon = append(this.statusBanner, $('span.codicon.codicon-pass'));
		this.statusBannerText = append(this.statusBanner, $('span.re-status-text'));
		this.statusBannerText.textContent = localize('resourcesExplorer.statusLoading', "Loading…");

		// Tab bodies (one container per tab; only active is visible)
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

	// --- tab content scaffolds (DOM only; values filled by update*) ---

	private overviewCards: { cpu: HTMLElement; mem: HTMLElement; disk: HTMLElement } | undefined;

	private buildOverviewTab(): void {
		const body = this.tabBodies.get('overview')!;
		clearNode(body);

		const grid = append(body, $('.re-overview-grid'));

		const cpuCard = this.buildSummaryCard(grid, localize('resourcesExplorer.cpuSystem', "CPU (System)"));
		const memCard = this.buildSummaryCard(grid, localize('resourcesExplorer.memorySystem', "Memory (System)"));
		const diskCard = this.buildSummaryCard(grid, localize('resourcesExplorer.diskSystem', "Disk (System)"));

		this.overviewCards = { cpu: cpuCard, mem: memCard, disk: diskCard };
	}

	private buildSummaryCard(parent: HTMLElement, title: string): HTMLElement {
		const card = append(parent, $('.re-card'));
		const header = append(card, $('.re-card-header'));
		append(header, $('span.re-card-title')).textContent = title;
		const valueEl = append(card, $('.re-card-value'));
		valueEl.textContent = '—';
		return valueEl;
	}

	private cpuMemoryBody: HTMLElement | undefined;
	private cpuInfoRow: HTMLElement | undefined;
	private memInfoRow: HTMLElement | undefined;

	private buildCpuMemoryTab(): void {
		const body = this.tabBodies.get('cpu-memory')!;
		clearNode(body);
		this.cpuMemoryBody = body;

		// CPU card
		const cpuPanel = append(body, $('.re-detail-panel'));
		append(cpuPanel, $('.re-detail-title')).textContent = localize('resourcesExplorer.cpuProcessor', "CPU Processor");
		this.cpuInfoRow = append(cpuPanel, $('.re-detail-row'));
		this.cpuInfoRow.textContent = '—';

		// Memory card
		const memPanel = append(body, $('.re-detail-panel'));
		append(memPanel, $('.re-detail-title')).textContent = localize('resourcesExplorer.physicalMemory', "Physical Memory");
		this.memInfoRow = append(memPanel, $('.re-detail-row'));
		this.memInfoRow.textContent = '—';
	}

	private diskInfoEl: HTMLElement | undefined;

	private buildDiskTab(): void {
		const body = this.tabBodies.get('disk')!;
		clearNode(body);

		const panel = append(body, $('.re-detail-panel'));
		append(panel, $('.re-detail-title')).textContent = localize('resourcesExplorer.disk', "Disk");
		this.diskInfoEl = append(panel, $('.re-detail-row'));
		this.diskInfoEl.textContent = localize('resourcesExplorer.diskUnavailable', "Disk usage details require host integration. Live disk stats coming soon.");
	}

	private networkOnlineEl: HTMLElement | undefined;
	private networkPlatformEl: HTMLElement | undefined;

	private buildNetworkTab(): void {
		const body = this.tabBodies.get('network')!;
		clearNode(body);

		const panel = append(body, $('.re-detail-panel'));
		append(panel, $('.re-detail-title')).textContent = localize('resourcesExplorer.connectivity', "Connectivity");

		const onlineRow = append(panel, $('.re-detail-row'));
		append(onlineRow, $('span.re-key')).textContent = localize('resourcesExplorer.networkStatus', "Network status:");
		this.networkOnlineEl = append(onlineRow, $('span.re-value'));
		this.networkOnlineEl.textContent = '—';

		const platformRow = append(panel, $('.re-detail-row'));
		append(platformRow, $('span.re-key')).textContent = localize('resourcesExplorer.platform', "Platform:");
		this.networkPlatformEl = append(platformRow, $('span.re-value'));
		this.networkPlatformEl.textContent = '—';
	}

	// --- live data ---

	private async update(): Promise<void> {
		try {
			const [stats, props] = await Promise.all([
				this.nativeHostService.getOSStatistics(),
				this.nativeHostService.getOSProperties()
			]);

			const memPercent = Math.round(((stats.totalmem - stats.freemem) / stats.totalmem) * 100);
			// Approximate CPU% from 1-min load average divided by cpu count.
			// Not exact on Windows (loadavg is mostly 0 there) but it's the
			// only sync number we get via the existing native API — good
			// enough for an indicator. Clamped to 0..100.
			const cpuCount = props.cpus?.length || 1;
			const load = stats.loadavg?.[0] ?? 0;
			const cpuPercent = Math.max(0, Math.min(100, Math.round((load / cpuCount) * 100)));

			this.currentSnapshot = {
				stats,
				props,
				cpuPercent,
				memPercent,
				online: navigator.onLine
			};

			this.renderAll();
		} catch {
			// Keep last-known data on transient failures.
		}
	}

	private renderAll(): void {
		const snap = this.currentSnapshot;
		if (!snap) {
			return;
		}

		this.renderStatusBanner(snap);
		this.renderOverview(snap);
		this.renderCpuMemory(snap);
		this.renderNetwork(snap);
	}

	private renderStatusBanner(snap: ISnapshot): void {
		const high = snap.memPercent >= 90 || snap.cpuPercent >= 90;

		this.statusBanner.classList.toggle('warning', high);
		this.statusBannerIcon.className = high
			? 'codicon codicon-warning'
			: 'codicon codicon-pass';
		this.statusBannerText.textContent = high
			? localize('resourcesExplorer.statusHigh', "High resource usage detected.")
			: localize('resourcesExplorer.statusOk', "The system has not detected any high resource usage.");
	}

	private renderOverview(snap: ISnapshot): void {
		if (!this.overviewCards) {
			return;
		}
		this.overviewCards.cpu.textContent = `${snap.cpuPercent}%`;
		this.overviewCards.mem.textContent = `${snap.memPercent}%`;
		// Disk is unavailable from current native APIs — keep a placeholder.
		this.overviewCards.disk.textContent = '—';
	}

	private renderCpuMemory(snap: ISnapshot): void {
		if (this.cpuInfoRow) {
			const firstCpu: ICPUProperties | undefined = snap.props.cpus?.[0];
			const cpuModel = firstCpu?.model?.trim() || localize('resourcesExplorer.unknownCpu', "Unknown CPU");
			const cpuCount = snap.props.cpus?.length ?? 0;
			reset(this.cpuInfoRow,
				$('span.re-key', {}, localize('resourcesExplorer.processor', "Processor:")),
				$('span.re-value', {}, `${cpuModel} (${cpuCount} cores)`)
			);
		}

		if (this.memInfoRow) {
			const totalGB = (snap.stats.totalmem / (1024 ** 3)).toFixed(2);
			const usedGB = ((snap.stats.totalmem - snap.stats.freemem) / (1024 ** 3)).toFixed(2);
			reset(this.memInfoRow,
				$('span.re-key', {}, localize('resourcesExplorer.usage', "Usage:")),
				$('span.re-value', {}, `${usedGB} GB / ${totalGB} GB  (${snap.memPercent}%)`)
			);
		}
	}

	private renderNetwork(snap: ISnapshot): void {
		if (this.networkOnlineEl) {
			this.networkOnlineEl.textContent = snap.online
				? localize('resourcesExplorer.online', "Online")
				: localize('resourcesExplorer.offline', "Offline");
			this.networkOnlineEl.classList.toggle('re-value-good', snap.online);
			this.networkOnlineEl.classList.toggle('re-value-bad', !snap.online);
		}
		if (this.networkPlatformEl) {
			this.networkPlatformEl.textContent = `${snap.props.platform} ${snap.props.release} (${snap.props.arch})`;
		}
	}
}
