/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from 'vs/base/common/lifecycle';
import { LRUCache } from 'vs/base/common/map';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IInstantiationService, ServicesAccessor } from 'vs/platform/instantiation/common/instantiation';
import { IStorageService, StorageScope, StorageTarget } from 'vs/platform/storage/common/storage';
import { TerminalSettingId, TerminalShellType } from 'vs/platform/terminal/common/terminal';

/**
 * Tracks a list of generic entries.
 */
export interface ITerminalPersistedHistory<T> {
	/**
	 * The persisted entries.
	 */
	readonly entries: IterableIterator<[string, T]>;
	/**
	 * Adds an entry.
	 */
	add(key: string, value: T): void;
	/**
	 * Removes an entry.
	 */
	remove(key: string): void;
	/**
	 * Clears all entries.
	 */
	clear(): void;
}

interface ISerializedCache<T> {
	entries: { key: string; value: T }[];
}

const enum Constants {
	DefaultHistoryLimit = 100
}

const enum StorageKeys {
	Keys = 'terminal.history.keys',
	Entries = 'terminal.history.entries',
	Timestamp = 'terminal.history.timestamp'
}

let commandHistory: ITerminalPersistedHistory<{ shellType: TerminalShellType }> | undefined = undefined;
export function getCommandHistory(accessor: ServicesAccessor): ITerminalPersistedHistory<{ shellType: TerminalShellType }> {
	if (!commandHistory) {
		commandHistory = accessor.get(IInstantiationService).createInstance(TerminalPersistedHistory, 'commands') as TerminalPersistedHistory<{ shellType: TerminalShellType }>;
	}
	return commandHistory;
}

class TerminalPersistedHistory<T> extends Disposable implements ITerminalPersistedHistory<T> {
	private readonly _entries: LRUCache<string, T>;
	private _timestamp: number = 0;
	private _isReady = false;
	private _isStale = true;

	get entries(): IterableIterator<[string, T]> {
		this._ensureUpToDate();
		return this._entries.entries();
	}

	constructor(
		private readonly _storageDataKey: string,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IStorageService private readonly _storageService: IStorageService
	) {
		super();

		// Init cache
		this._entries = new LRUCache<string, T>(this._getHistoryLimit());

		// Listen for config changes to set history limit
		this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(TerminalSettingId.ShellIntegrationCommandHistory)) {
				this._entries.limit = this._getHistoryLimit();
			}
		});

		// Listen to cache changes from other windows
		this._storageService.onDidChangeValue(e => {
			if (e.key !== StorageKeys.Timestamp) {
				this._isStale = true;
			}
		});
	}

	add(key: string, value: T) {
		this._ensureUpToDate();
		this._entries.set(key, value);
		this._saveState();
	}

	remove(key: string) {
		this._ensureUpToDate();
		this._entries.delete(key);
		this._saveState();
	}

	clear() {
		this._ensureUpToDate();
		this._entries.clear();
		this._saveState();
	}

	private _ensureUpToDate() {
		// Initial load
		if (!this._isReady) {
			this._loadState();
			this._isReady = true;
		}

		// TODO: Resolve stale cache
		if (this._isStale) {
			this._isStale = false;
		}
	}

	private _loadState() {
		this._timestamp = this._storageService.getNumber(`${StorageKeys.Timestamp}.${this._storageDataKey}`, StorageScope.GLOBAL, 0);

		// Load global entries plus
		const raw = this._storageService.get(`${StorageKeys.Entries}.${this._storageDataKey}`, StorageScope.GLOBAL);
		if (raw === undefined || raw.length === 0) {
			return;
		}
		let serialized: ISerializedCache<T> | undefined = undefined;
		try {
			serialized = JSON.parse(raw);
		} catch {
			// Invalid data
			return;
		}
		if (serialized) {
			for (const entry of serialized.entries) {
				this._entries.set(entry.key, entry.value);
			}
		}
	}

	private _saveState() {
		const serialized: ISerializedCache<T> = { entries: [] };
		this._entries.forEach((value, key) => serialized.entries.push({ key, value }));
		this._storageService.store(`${StorageKeys.Entries}.${this._storageDataKey}`, JSON.stringify(serialized), StorageScope.GLOBAL, StorageTarget.MACHINE);
		this._timestamp = Date.now();
		this._storageService.store(`${StorageKeys.Timestamp}.${this._storageDataKey}`, this._timestamp, StorageScope.GLOBAL, StorageTarget.MACHINE);
	}

	private _getHistoryLimit() {
		const historyLimit = this._configurationService.getValue(TerminalSettingId.ShellIntegrationCommandHistory);
		return typeof historyLimit === 'number' ? historyLimit : Constants.DefaultHistoryLimit;
	}
}
