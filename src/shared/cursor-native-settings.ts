export type CursorSettingKind = 'model' | 'mode' | 'permission';
export interface CursorSettingOption { id: string; label: string; disabled?: boolean; description?: string }
export interface CursorSettingValue extends CursorSettingOption { options: CursorSettingOption[] }
export interface CursorSettingsChange { id: string; kind: CursorSettingKind; value: string; label: string; revision: string; state: 'waiting' | 'confirming' | 'error'; error?: string }
/** Observations of the linked native composer. Never a second CLI configuration. */
export interface CursorNativeSettings {
  state: 'ready' | 'unavailable';
  revision: string;
  model?: CursorSettingValue;
  mode?: CursorSettingValue;
  permission?: CursorSettingValue;
  error?: string;
  pending?: CursorSettingsChange;
}
