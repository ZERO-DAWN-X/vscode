/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

const resourcesExplorerIcon = registerIcon('resources-explorer-editor-label-icon', Codicon.pulse, localize('resourcesExplorerEditorLabelIcon', 'Icon of the Resources Explorer editor label.'));

/**
 * Singleton editor input for the Resources Explorer. Modeled on
 * ProcessExplorerEditorInput — readonly, single instance, fixed resource URI
 * so opening the same editor twice reuses the existing tab.
 */
export class ResourcesExplorerEditorInput extends EditorInput {

	static readonly ID = 'workbench.editor.resourcesExplorer';

	static readonly RESOURCE = URI.from({
		scheme: 'resources-explorer',
		path: 'default'
	});

	private static _instance: ResourcesExplorerEditorInput;
	static get instance() {
		if (!ResourcesExplorerEditorInput._instance || ResourcesExplorerEditorInput._instance.isDisposed()) {
			ResourcesExplorerEditorInput._instance = new ResourcesExplorerEditorInput();
		}

		return ResourcesExplorerEditorInput._instance;
	}

	override get typeId(): string { return ResourcesExplorerEditorInput.ID; }

	override get editorId(): string | undefined { return ResourcesExplorerEditorInput.ID; }

	override get capabilities(): EditorInputCapabilities { return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton; }

	readonly resource = ResourcesExplorerEditorInput.RESOURCE;

	override getName(): string {
		return localize('resourcesExplorerInputName', "Resources Explorer");
	}

	override getIcon(): ThemeIcon {
		return resourcesExplorerIcon;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}

		return other instanceof ResourcesExplorerEditorInput;
	}
}
