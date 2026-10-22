import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  type RegexScript,
  type RegexPreset,
  SCRIPT_TYPES,
  type ScriptType,
  regex_placement,
  substitute_find_regex,
  getScriptsByType,
  saveScriptsByType,
  createEmptyRegexScript,
  exportRegexScript,
  importRegexScript,
  importRegexScriptsFromJson,
  isScopedScriptsAllowed,
  allowScopedScripts,
  disallowScopedScripts,
  isPresetScriptsAllowed,
  allowPresetScripts,
  disallowPresetScripts,
  getScriptType,
  getRegexPresets,
  saveRegexPresets,
  createEmptyRegexPreset,
  applyRegexPreset,
  deleteRegexPreset,
  exportRegexPreset,
  importRegexPreset,
} from './regexEngine';
const PLACEMENT_LABELS: Record<number, string> = {
  [regex_placement.MD_DISPLAY]: 'Display',
  [regex_placement.USER_INPUT]: 'User Input',
  [regex_placement.AI_OUTPUT]: 'AI Output',
  [regex_placement.SLASH_COMMAND]: 'Slash Command',
  [regex_placement.WORLD_INFO]: 'World Info',
  [regex_placement.REASONING]: 'Reasoning',
};

const SUBSTITUTES = [
  { value: substitute_find_regex.NONE, label: 'None' },
  { value: substitute_find_regex.RAW, label: 'Raw' },
  { value: substitute_find_regex.ESCAPED, label: 'Escaped' },
];

function ScriptEditor({
  script,
  onSave,
  onCancel,
}: {
  script: RegexScript;
  onSave: (script: RegexScript) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<RegexScript>({ ...script });

  const togglePlacement = (value: number) => {
    setDraft((prev) => ({
      ...prev,
      placement: prev.placement.includes(value) ? prev.placement.filter((p) => p !== value) : [...prev.placement, value],
    }));
  };
  return (
    <div className="regex-editor-overlay">
      <div className="regex-editor-panel">
        <h3>{script.scriptName ? 'Edit Regex Script' : 'New Regex Script'}</h3>
        <div className="regex-editor-fields">
          <label>
            Name
            <input value={draft.scriptName} onChange={(e) => setDraft({ ...draft, scriptName: e.target.value })} />
          </label>
          <label>
            Find Regex
            <input value={draft.findRegex} onChange={(e) => setDraft({ ...draft, findRegex: e.target.value })} placeholder="/pattern/flags or pattern" />
          </label>
          <label>
            Replace String
            <textarea value={draft.replaceString} onChange={(e) => setDraft({ ...draft, replaceString: e.target.value })} rows={3} />
          </label>
          <label>
            Trim Strings (one per line)
            <textarea
              value={draft.trimStrings.join('\n')}
              onChange={(e) => setDraft({ ...draft, trimStrings: e.target.value.split('\n') })}
              rows={2}
            />
          </label>
          <div className="regex-checkboxes">
            <label>
              <input type="checkbox" checked={draft.disabled} onChange={(e) => setDraft({ ...draft, disabled: e.target.checked })} />
              Disabled
            </label>
            <label>
              <input type="checkbox" checked={draft.markdownOnly} onChange={(e) => setDraft({ ...draft, markdownOnly: e.target.checked })} />
              Markdown Only
            </label>
            <label>
              <input type="checkbox" checked={draft.promptOnly} onChange={(e) => setDraft({ ...draft, promptOnly: e.target.checked })} />
              Prompt Only
            </label>
            <label>
              <input type="checkbox" checked={draft.runOnEdit} onChange={(e) => setDraft({ ...draft, runOnEdit: e.target.checked })} />
              Run On Edit
            </label>
          </div>
          <label>
            Substitute Regex
            <select value={draft.substituteRegex} onChange={(e) => setDraft({ ...draft, substituteRegex: Number(e.target.value) })}>
              {SUBSTITUTES.map((s) => (
                <option value={s.value} key={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <div className="regex-depth-row">
            <label>
              Min Depth
              <input
                type="number"
                value={draft.minDepth ?? ''}
                onChange={(e) => setDraft({ ...draft, minDepth: e.target.value === '' ? null : Number(e.target.value) })}
              />
            </label>
            <label>
              Max Depth
              <input
                type="number"
                value={draft.maxDepth ?? ''}
                onChange={(e) => setDraft({ ...draft, maxDepth: e.target.value === '' ? null : Number(e.target.value) })}
              />
            </label>
          </div>
          <div className="regex-placements">
            <span>Affects:</span>
            {Object.entries(PLACEMENT_LABELS).map(([value, label]) => (
              <label key={value}>
                <input type="checkbox" checked={draft.placement.includes(Number(value))} onChange={() => togglePlacement(Number(value))} />
                {label}
              </label>
            ))}
          </div>
        </div>
        <div className="regex-editor-actions">
          <button type="button" onClick={() => onSave(draft)}>
            Save
          </button>
          <button type="button" className="ghost-button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="ghost-button" onClick={() => {
            const blob = new Blob([exportRegexScript(draft)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `regex-${draft.scriptName || 'untitled'}.json`;
            a.click();
            URL.revokeObjectURL(url);
          }}>
            Export
          </button>
          <label className="ghost-button" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', padding: '0.45rem 0.75rem', borderRadius: 'var(--radius-control)' }}>
            <span>Импорт .json</span>
            <input
              type="file"
              accept=".json,application/json"
              style={{ display: 'none' }}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                const text = await file.text();
                const imported = importRegexScript(text);
                if (imported) {
                  setDraft(imported);
                }
              }}
            />
          </label>
        </div>
      </div>
    </div>
  );
}

function ScriptList({
  title,
  scripts,
  type,
  onChange,
  onEdit,
}: {
  title: string;
  scripts: RegexScript[];
  type: ScriptType;
  onChange: (scripts: RegexScript[]) => void;
  onEdit: (script: RegexScript) => void;
}) {
  const moveScript = useCallback(
    (index: number, direction: number) => {
      const next = [...scripts];
      const newIndex = index + direction;
      if (newIndex < 0 || newIndex >= next.length) return;
      const temp = next[index];
      next[index] = next[newIndex];
      next[newIndex] = temp;
      onChange(next);
    },
    [scripts, onChange],
  );

  return (
    <div className="regex-script-list">
      <h4>{title}</h4>
      {scripts.length === 0 ? <p className="regex-empty">No scripts</p> : null}
      {scripts.map((script, index) => (
        <div className="regex-script-row" key={script.id}>
          <label className="regex-script-toggle" title={script.disabled ? 'Disabled' : 'Enabled'}>
            <input type="checkbox" checked={!script.disabled} onChange={(e) => {
              const next = [...scripts];
              next[index] = { ...script, disabled: !e.target.checked };
              onChange(next);
            }} />
            <span className="regex-script-name">{script.scriptName || 'Unnamed'}</span>
          </label>
          <div className="regex-script-meta">
            <small>{script.placement.map((p) => PLACEMENT_LABELS[p] || String(p)).join(', ')}</small>
          </div>
          <div className="regex-script-actions">
            <button type="button" title="Move up" disabled={index === 0} onClick={() => moveScript(index, -1)}>
              ↑
            </button>
            <button type="button" title="Move down" disabled={index === scripts.length - 1} onClick={() => moveScript(index, 1)}>
              ↓
            </button>
            <button type="button" onClick={() => onEdit(script)}>
              Edit
            </button>
            <button type="button" className="danger-button" onClick={() => {
              if (window.confirm(`Delete "${script.scriptName || 'this script'}"?`)) {
                onChange(scripts.filter((s) => s.id !== script.id));
              }
            }}>
              Delete
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export function RegexSettings() {
  const [globalScripts, setGlobalScripts] = useState<RegexScript[]>(() => getScriptsByType(SCRIPT_TYPES.GLOBAL));
  const [scopedScripts, setScopedScripts] = useState<RegexScript[]>(() => getScriptsByType(SCRIPT_TYPES.SCOPED));
  const [presetScripts, setPresetScripts] = useState<RegexScript[]>(() => getScriptsByType(SCRIPT_TYPES.PRESET));
  const [scopedAllowed, setScopedAllowed] = useState(() => isScopedScriptsAllowed());
  const [presetAllowed, setPresetAllowed] = useState(() => isPresetScriptsAllowed());
  const [editingScript, setEditingScript] = useState<RegexScript | null>(null);
  const [editingType, setEditingType] = useState<ScriptType>(SCRIPT_TYPES.GLOBAL);
  const [statusMessage, setStatusMessage] = useState('');

  const refresh = useCallback(() => {
    setGlobalScripts(getScriptsByType(SCRIPT_TYPES.GLOBAL));
    setScopedScripts(getScriptsByType(SCRIPT_TYPES.SCOPED));
    setPresetScripts(getScriptsByType(SCRIPT_TYPES.PRESET));
    setScopedAllowed(isScopedScriptsAllowed());
    setPresetAllowed(isPresetScriptsAllowed());
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener('doubletrouble:regex-updated', refresh);
    return () => window.removeEventListener('doubletrouble:regex-updated', refresh);
  }, [refresh]);

  const save = (type: ScriptType, scripts: RegexScript[]) => {
    saveScriptsByType(scripts, type);
    refresh();
  };

  const addScript = (type: ScriptType) => {
    setEditingType(type);
    setEditingScript(createEmptyRegexScript());
  };

  const handleImportFiles = async (type: ScriptType, files: FileList | null) => {
    if (!files || !files.length) return;
    const current = [...getScriptsByType(type)];
    let addedCount = 0;
    for (const file of Array.from(files)) {
      try {
        const text = await file.text();
        const importedList = importRegexScriptsFromJson(text);
        for (const item of importedList) {
          const existingIdx = current.findIndex((s) => s.id === item.id);
          if (existingIdx >= 0) {
            current[existingIdx] = item;
          } else {
            current.push(item);
          }
          addedCount += 1;
        }
      } catch {
        // ignore invalid file
      }
    }
    if (addedCount > 0) {
      if (type === SCRIPT_TYPES.SCOPED) allowScopedScripts();
      if (type === SCRIPT_TYPES.PRESET) allowPresetScripts();
      save(type, current);
      setStatusMessage(`Импортировано скриптов: ${addedCount}`);
    } else {
      setStatusMessage('Не удалось распознать JSON регекса в выбранном файле.');
    }
  };

  const handleSaveEditor = (script: RegexScript) => {
    const current = getScriptsByType(editingType);
    const existingIndex = current.findIndex((s) => s.id === script.id);
    const next = [...current];
    if (existingIndex >= 0) {
      next[existingIndex] = script;
    } else {
      next.push(script);
    }
    save(editingType, next);
    setEditingScript(null);
  };

  const handleEdit = (script: RegexScript) => {
    const type = getScriptType(script);
    if (type === SCRIPT_TYPES.GLOBAL || type === SCRIPT_TYPES.SCOPED || type === SCRIPT_TYPES.PRESET) {
      setEditingType(type);
      setEditingScript({ ...script });
    }
  };

  const moveToType = (script: RegexScript, fromType: ScriptType, toType: ScriptType) => {
    const fromScripts = getScriptsByType(fromType).filter((s) => s.id !== script.id);
    const toScripts = [...getScriptsByType(toType), script];
    saveScriptsByType(fromScripts, fromType);
    saveScriptsByType(toScripts, toType);
    refresh();
  };

  return (
    <div className="regex-settings">
      <div className="regex-settings-header">
        <h3>Regex Scripts</h3>
        <p className="helper-text">Global, scoped (per character) and preset regex replacements.</p>
      </div>

      <div className="regex-allow-toggles">
        <label>
          <input type="checkbox" checked={scopedAllowed} onChange={(e) => {
            if (e.target.checked) allowScopedScripts(); else disallowScopedScripts();
            setScopedAllowed(e.target.checked);
          }} />
          Allow Scoped Scripts
        </label>
        <label>
          <input type="checkbox" checked={presetAllowed} onChange={(e) => {
            if (e.target.checked) allowPresetScripts(); else disallowPresetScripts();
            setPresetAllowed(e.target.checked);
          }} />
          Allow Preset Scripts
        </label>
      </div>

      {statusMessage ? <p className="library-message">{statusMessage}</p> : null}

      <ScriptList title="Global Scripts (Глобальные)" scripts={globalScripts} type={SCRIPT_TYPES.GLOBAL} onChange={(s) => save(SCRIPT_TYPES.GLOBAL, s)} onEdit={handleEdit} />
      <div className="regex-add-row">
        <button type="button" onClick={() => addScript(SCRIPT_TYPES.GLOBAL)}>+ Добавить Global</button>
        <label className="ghost-button" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', padding: '0.45rem 0.75rem', borderRadius: 'var(--radius-control)', fontSize: '0.85rem' }}>
          <span>📂 Импорт регекса (.json)</span>
          <input
            type="file"
            accept=".json,application/json"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              const files = e.target.files;
              void handleImportFiles(SCRIPT_TYPES.GLOBAL, files).then(() => { e.target.value = ''; });
            }}
          />
        </label>
      </div>

      <ScriptList title="Scoped Scripts (Для текущей карточки)" scripts={scopedScripts} type={SCRIPT_TYPES.SCOPED} onChange={(s) => save(SCRIPT_TYPES.SCOPED, s)} onEdit={handleEdit} />
      <div className="regex-add-row">
        <button type="button" onClick={() => addScript(SCRIPT_TYPES.SCOPED)}>+ Добавить Scoped</button>
        <label className="ghost-button" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', padding: '0.45rem 0.75rem', borderRadius: 'var(--radius-control)', fontSize: '0.85rem' }}>
          <span>📂 Импорт в карточку (.json)</span>
          <input
            type="file"
            accept=".json,application/json"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              const files = e.target.files;
              void handleImportFiles(SCRIPT_TYPES.SCOPED, files).then(() => { e.target.value = ''; });
            }}
          />
        </label>
        {scopedScripts.map((script) => (
          <button type="button" key={script.id} className="ghost-button tiny-button" onClick={() => moveToType(script, SCRIPT_TYPES.SCOPED, SCRIPT_TYPES.GLOBAL)}>
            Move {script.scriptName || 'Unnamed'} to Global
          </button>
        ))}
      </div>

      <ScriptList title="Preset Scripts (Для текущего пресета)" scripts={presetScripts} type={SCRIPT_TYPES.PRESET} onChange={(s) => save(SCRIPT_TYPES.PRESET, s)} onEdit={handleEdit} />
      <div className="regex-add-row">
        <button type="button" onClick={() => addScript(SCRIPT_TYPES.PRESET)}>+ Добавить Preset</button>
        <label className="ghost-button" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', padding: '0.45rem 0.75rem', borderRadius: 'var(--radius-control)', fontSize: '0.85rem' }}>
          <span>📂 Импорт в пресет (.json)</span>
          <input
            type="file"
            accept=".json,application/json"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              const files = e.target.files;
              void handleImportFiles(SCRIPT_TYPES.PRESET, files).then(() => { e.target.value = ''; });
            }}
          />
        </label>
        {presetScripts.map((script) => (
          <button type="button" key={script.id} className="ghost-button tiny-button" onClick={() => moveToType(script, SCRIPT_TYPES.PRESET, SCRIPT_TYPES.GLOBAL)}>
            Move {script.scriptName || 'Unnamed'} to Global
          </button>
        ))}
      </div>
      {editingScript && (
        <ScriptEditor
          script={editingScript}
          onSave={handleSaveEditor}
          onCancel={() => setEditingScript(null)}
        />
      )}

      <PresetManager onApply={refresh} />
    </div>
  );
}

function PresetManager({ onApply }: { onApply: () => void }) {
  const [presets, setPresets] = useState<RegexPreset[]>(() => getRegexPresets());
  const [editingPreset, setEditingPreset] = useState<RegexPreset | null>(null);

  const refreshPresets = () => setPresets(getRegexPresets());

  const handleSavePreset = (preset: RegexPreset) => {
    const current = getRegexPresets();
    const index = current.findIndex((p) => p.id === preset.id);
    const next = [...current];
    if (index >= 0) {
      next[index] = preset;
    } else {
      next.push(preset);
    }
    saveRegexPresets(next);
    setEditingPreset(null);
    refreshPresets();
  };

  const handleApplyPreset = (presetId: string) => {
    if (applyRegexPreset(presetId)) {
      onApply();
    }
  };

  return (
    <div className="regex-preset-manager">
      <h4>Preset Manager</h4>
      <p className="helper-text">Save and load collections of regex scripts.</p>
      {presets.length === 0 ? <p className="regex-empty">No presets saved</p> : null}
      {presets.map((preset) => (
        <div className="regex-preset-row" key={preset.id}>
          <span className="regex-preset-name">{preset.name || 'Unnamed Preset'}</span>
          <small className="regex-preset-meta">G:{preset.global.length} S:{preset.scoped.length} P:{preset.preset.length}</small>
          <div className="regex-preset-actions">
            <button type="button" onClick={() => handleApplyPreset(preset.id)}>Apply</button>
            <button type="button" onClick={() => setEditingPreset({ ...preset })}>Edit</button>
            <button type="button" className="danger-button" onClick={() => {
              if (window.confirm(`Delete preset "${preset.name || 'this preset'}"?`)) {
                deleteRegexPreset(preset.id);
                refreshPresets();
              }
            }}>Delete</button>
            <button type="button" className="ghost-button" onClick={() => {
              const blob = new Blob([exportRegexPreset(preset)], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `regex-preset-${preset.name || 'untitled'}.json`;
              a.click();
              URL.revokeObjectURL(url);
            }}>Export</button>
          </div>
        </div>
      ))}
      <div className="regex-add-row">
        <button type="button" onClick={() => setEditingPreset(createEmptyRegexPreset())}>Save Current as Preset</button>
        <label className="ghost-button" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', padding: '0.45rem 0.75rem', borderRadius: 'var(--radius-control)', fontSize: '0.85rem' }}>
          <span>📂 Import Preset (.json)</span>
          <input
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              const text = await file.text();
              const imported = importRegexPreset(text, file.name.replace(/\.json$/i, ''));
              if (imported) {
                handleSavePreset(imported);
                applyRegexPreset(imported.id);
                onApply();
              }
            }}
          />
        </label>
      </div>
      {editingPreset && (
        <div className="regex-editor-overlay">
          <div className="regex-editor-panel">
            <h3>{editingPreset.name ? 'Edit Preset' : 'New Preset'}</h3>
            <label>
              Preset Name
              <input value={editingPreset.name} onChange={(e) => setEditingPreset({ ...editingPreset, name: e.target.value })} />
            </label>
            <p className="helper-text">This preset will capture current Global, Scoped, and Preset scripts.</p>
            <div className="regex-editor-actions">
              <button type="button" onClick={() => {
                const updated = {
                  ...editingPreset,
                  global: getScriptsByType(SCRIPT_TYPES.GLOBAL),
                  scoped: getScriptsByType(SCRIPT_TYPES.SCOPED),
                  preset: getScriptsByType(SCRIPT_TYPES.PRESET),
                };
                handleSavePreset(updated);
              }}>Save</button>
              <button type="button" className="ghost-button" onClick={() => setEditingPreset(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function RegexSettingsPortal() {
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setHost(document.getElementById('extensions_settings'));
  }, []);

  if (!host) {
    return null;
  }

  return createPortal(
    <div className="regex-settings image-extension-settings-portal" data-dt-extension-owner="regex">
      <RegexSettings />
    </div>,
    host,
  );
}
