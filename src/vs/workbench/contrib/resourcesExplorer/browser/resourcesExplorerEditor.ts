/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Dimension } from '../../../../base/browser/dom.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { ResourcesExplorerControl } from './resourcesExplorerControl.js';

/**
 * EditorPane host for the Resources Explorer. Mirrors the ProcessExplorer
 * pattern: a thin shell that owns lifecycle (focus, layout) and delegates
 * actual DOM building to ResourcesExplorerControl.
 */
export class ResourcesExplorerEditor extends EditorPane {

	static readonly ID: string = 'workbench.editor.resourcesExplorer';

	private control: ResourcesExplorerControl | undefined = undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) {
		super(ResourcesExplorerEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.control = this._register(this.instantiationService.createInstance(ResourcesExplorerControl, parent));
	}

	override focus(): void {
		this.control?.focus();
	}

	override layout(dimension: Dimension): void {
		this.control?.layout(dimension);
	}
}
