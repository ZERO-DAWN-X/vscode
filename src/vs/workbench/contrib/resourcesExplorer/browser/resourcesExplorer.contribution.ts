/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/resourcesExplorerStatusBar.css';
import { disposableWindowInterval } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IRectangle } from '../../../../platform/window/common/window.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { EditorExtensions, GroupIdentifier, IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { IAuxiliaryWindowService } from '../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../services/editor/common/editorResolverService.js';
import { AUX_WINDOW_GROUP, IEditorService } from '../../../services/editor/common/editorService.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { ResourcesExplorerEditor } from './resourcesExplorerEditor.js';
import { ResourcesExplorerEditorInput } from './resourcesExplorerEditorInput.js';

//#region --- editor pane registration

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		ResourcesExplorerEditor,
		ResourcesExplorerEditor.ID,
		localize('resourcesExplorerEditor', "Resources Explorer Editor")
	),
	[new SyncDescriptor(ResourcesExplorerEditorInput)]
);

class ResourcesExplorerEditorContribution implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.resourcesExplorerEditor';

	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService,
		@IInstantiationService instantiationService: IInstantiationService
	) {
		editorResolverService.registerEditor(
			`${ResourcesExplorerEditorInput.RESOURCE.scheme}:**/**`,
			{
				id: ResourcesExplorerEditorInput.ID,
				label: localize('promptOpenWith.resourcesExplorer.displayName', "Resources Explorer"),
				priority: RegisteredEditorPriority.exclusive
			},
			{
				singlePerResource: true,
				canSupportResource: resource => resource.scheme === ResourcesExplorerEditorInput.RESOURCE.scheme
			},
			{
				createEditorInput: () => {
					return {
						editor: instantiationService.createInstance(ResourcesExplorerEditorInput),
						options: { pinned: true }
					};
				}
			}
		);
	}
}

registerWorkbenchContribution2(ResourcesExplorerEditorContribution.ID, ResourcesExplorerEditorContribution, WorkbenchPhase.BlockStartup);

class ResourcesExplorerEditorInputSerializer implements IEditorSerializer {

	canSerialize(_editorInput: EditorInput): boolean { return true; }

	serialize(_editorInput: EditorInput): string { return ''; }

	deserialize(_instantiationService: IInstantiationService): EditorInput {
		return ResourcesExplorerEditorInput.instance;
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(ResourcesExplorerEditorInput.ID, ResourcesExplorerEditorInputSerializer);

//#endregion

//#region --- open command + window state persistence

interface IResourcesExplorerWindowState {
	readonly bounds: Partial<IRectangle>;
}

class OpenResourcesExplorer extends Action2 {

	static readonly ID = 'workbench.action.openResourcesExplorer';

	private static readonly STATE_KEY = 'workbench.resourcesExplorerWindowState';
	private static readonly DEFAULT_STATE: IResourcesExplorerWindowState = { bounds: { width: 900, height: 600 } };

	constructor() {
		super({
			id: OpenResourcesExplorer.ID,
			title: localize2('openResourcesExplorer', "Open Resources Explorer"),
			category: Categories.Developer,
			f1: true
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const editorGroupService = accessor.get(IEditorGroupsService);
		const auxiliaryWindowService = accessor.get(IAuxiliaryWindowService);
		const storageService = accessor.get(IStorageService);

		const pane = await editorService.openEditor({
			resource: ResourcesExplorerEditorInput.RESOURCE,
			options: {
				pinned: true,
				revealIfOpened: true,
				auxiliary: {
					...this.loadState(storageService),
					compact: true,
					alwaysOnTop: false
				}
			}
		}, AUX_WINDOW_GROUP);

		if (pane) {
			const listener = pane.input?.onWillDispose(() => {
				listener?.dispose();
				this.saveState(pane.group.id, storageService, editorGroupService, auxiliaryWindowService);
			});
		}
	}

	private loadState(storageService: IStorageService): IResourcesExplorerWindowState {
		const stateRaw = storageService.get(OpenResourcesExplorer.STATE_KEY, StorageScope.APPLICATION);
		if (!stateRaw) {
			return OpenResourcesExplorer.DEFAULT_STATE;
		}

		try {
			return JSON.parse(stateRaw);
		} catch {
			return OpenResourcesExplorer.DEFAULT_STATE;
		}
	}

	private saveState(group: GroupIdentifier, storageService: IStorageService, editorGroupService: IEditorGroupsService, auxiliaryWindowService: IAuxiliaryWindowService): void {
		const auxiliaryWindow = auxiliaryWindowService.getWindow(editorGroupService.getPart(group).windowId);
		if (!auxiliaryWindow) {
			return;
		}

		const bounds = auxiliaryWindow.createState().bounds;
		if (!bounds) {
			return;
		}

		storageService.store(OpenResourcesExplorer.STATE_KEY, JSON.stringify({ bounds }), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}
}

registerAction2(OpenResourcesExplorer);

//#endregion

//#region --- status bar indicator (live MEM%)

/**
 * Right-aligned status-bar entry showing system memory % with live updates.
 * Click opens the Resources Explorer editor in an auxiliary window.
 */
class ResourcesExplorerStatusBarContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.resourcesExplorerStatusBar';

	private static readonly REFRESH_INTERVAL_MS = 3000;
	private static readonly STATUS_BAR_ID = 'status.resourcesExplorer';

	private readonly entry: IStatusbarEntryAccessor;

	constructor(
		@IStatusbarService statusbarService: IStatusbarService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
	) {
		super();

		this.entry = this._register(statusbarService.addEntry(
			this.buildEntry(undefined),
			ResourcesExplorerStatusBarContribution.STATUS_BAR_ID,
			StatusbarAlignment.RIGHT,
			10
		));

		this.update();
		this._register(disposableWindowInterval(
			mainWindow,
			() => this.update(),
			ResourcesExplorerStatusBarContribution.REFRESH_INTERVAL_MS
		));
	}

	private async update(): Promise<void> {
		try {
			const stats = await this.nativeHostService.getOSStatistics();
			const used = stats.totalmem - stats.freemem;
			const percent = Math.round((used / stats.totalmem) * 100);
			this.entry.update(this.buildEntry(percent));
		} catch {
			// Keep last-known value on transient failures.
		}
	}

	private buildEntry(percent: number | undefined): IStatusbarEntry {
		const text = percent === undefined ? '$(pulse) MEM —' : `$(pulse) MEM ${percent}%`;
		return {
			name: localize('resourcesExplorer.statusName', "Resources"),
			text,
			ariaLabel: percent === undefined
				? localize('resourcesExplorer.statusAriaLoading', "Memory usage, loading")
				: localize('resourcesExplorer.statusAria', "Memory usage: {0}%", percent),
			tooltip: localize('resourcesExplorer.statusTooltip', "Open Resources Explorer"),
			command: OpenResourcesExplorer.ID,
			// Brand-green background with dark text — makes the indicator
			// pop in the status bar so it's easy to spot at a glance.
			backgroundColor: '#B0D605',
			color: '#181D27'
		};
	}
}

registerWorkbenchContribution2(
	ResourcesExplorerStatusBarContribution.ID,
	ResourcesExplorerStatusBarContribution,
	WorkbenchPhase.AfterRestored
);

//#endregion
