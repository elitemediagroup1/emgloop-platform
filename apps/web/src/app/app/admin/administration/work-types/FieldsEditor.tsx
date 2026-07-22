'use client';

// FieldsEditor — configure a Work Type's type-specific information fields with no
// code change. Each field has a label, a type (one of the 11 supported), optional
// helper text, required/active flags, and (for dropdowns) a comma-separated option
// list. Order is the row order. Start Work + Work Detail render these when set.
// Persistence + key derivation happen server-side (saveWorkTypeFieldsAction); the
// stable key is shown read-only once assigned.

import { useState } from 'react';
import Link from 'next/link';
import { saveWorkTypeFieldsAction } from './actions';

const FIELD_TYPES: { value: string; label: string }[] = [
  { value: 'short_text', label: 'Short text' },
  { value: 'long_text', label: 'Long text' },
  { value: 'number', label: 'Number' },
  { value: 'currency', label: 'Currency' },
  { value: 'date', label: 'Date' },
  { value: 'time', label: 'Time' },
  { value: 'dropdown', label: 'Dropdown' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone' },
  { value: 'url', label: 'URL' },
];

interface FieldRow {
  key: string;
  label: string;
  helper: string;
  type: string;
  required: boolean;
  options: string;
  active: boolean;
}

export interface InitialField {
  key: string;
  label: string;
  helper?: string;
  type: string;
  required: boolean;
  options?: string[];
  active: boolean;
}

function emptyRow(): FieldRow {
  return { key: '', label: '', helper: '', type: 'short_text', required: false, options: '', active: true };
}

export default function FieldsEditor({
  workTypeId,
  workTypeName,
  initialFields,
}: {
  workTypeId: string;
  workTypeName: string;
  initialFields: InitialField[];
}) {
  const [fields, setFields] = useState<FieldRow[]>(
    initialFields.map((f) => ({
      key: f.key,
      label: f.label,
      helper: f.helper ?? '',
      type: f.type,
      required: f.required,
      options: (f.options ?? []).join(', '),
      active: f.active,
    })),
  );

  const patch = (i: number, p: Partial<FieldRow>) => setFields((fs) => fs.map((f, idx) => (idx === i ? { ...f, ...p } : f)));
  const add = () => setFields((fs) => [...fs, emptyRow()]);
  const remove = (i: number) => setFields((fs) => fs.filter((_, idx) => idx !== i));
  const move = (i: number, dir: -1 | 1) =>
    setFields((fs) => {
      const j = i + dir;
      if (j < 0 || j >= fs.length) return fs;
      const next = [...fs];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  return (
    <div className="loop-os">
      <div className="sw2">
        <div className="sw2-head">
          <h1 className="sw2-title">Fields for {workTypeName}</h1>
          <p className="sw2-sub">
            Extra information collected when starting {workTypeName} work. Leave empty for none.
          </p>
        </div>

        <form action={saveWorkTypeFieldsAction} className="sw2-form">
          <input type="hidden" name="id" value={workTypeId} />
          <input
            type="hidden"
            name="fields"
            value={JSON.stringify(
              fields.map((f) => ({
                key: f.key,
                label: f.label,
                helper: f.helper,
                type: f.type,
                required: f.required,
                options: f.options,
                active: f.active,
              })),
            )}
          />

          <section className="sw2-section">
            <div className="sw2-sectionhead">
              <h2 className="sw2-h">Fields</h2>
              <button type="button" className="adm-btn" onClick={add}>Add field</button>
            </div>

            {fields.length === 0 ? (
              <p className="sw2-help">No fields yet. Add one to collect type-specific details at Start Work.</p>
            ) : (
              <div className="sw2-steps">
                {fields.map((f, i) => (
                  <div className="sw2-step" key={i}>
                    <div className="sw2-step-head">
                      <span className="sw2-step-num">{i + 1}</span>
                      <input className="sw2-input sw2-step-name" value={f.label} onChange={(e) => patch(i, { label: e.target.value })} placeholder="Field label (e.g. Payout)" />
                      <div className="sw2-step-tools">
                        <button type="button" className="adm-btn" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
                        <button type="button" className="adm-btn" onClick={() => move(i, 1)} disabled={i === fields.length - 1} aria-label="Move down">↓</button>
                        <button type="button" className="adm-btn adm-btn--danger" onClick={() => remove(i)} aria-label="Remove field">Remove</button>
                      </div>
                    </div>
                    {f.key ? <p className="sw2-help">Key: <code>{f.key}</code> (kept stable so saved values stay linked)</p> : null}

                    <div className="sw2-assign">
                      <label className="sw2-field">
                        <span className="sw2-label">Type</span>
                        <select className="sw2-input" value={f.type} onChange={(e) => patch(i, { type: e.target.value })}>
                          {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                        </select>
                      </label>
                      <label className="sw2-field">
                        <span className="sw2-label">Helper text <span className="sw2-opt">Optional</span></span>
                        <input className="sw2-input" value={f.helper} onChange={(e) => patch(i, { helper: e.target.value })} placeholder="Shown under the field" />
                      </label>
                    </div>

                    {f.type === 'dropdown' ? (
                      <label className="sw2-field">
                        <span className="sw2-label">Options <span className="sw2-opt">comma-separated</span></span>
                        <input className="sw2-input" value={f.options} onChange={(e) => patch(i, { options: e.target.value })} placeholder="Bronze, Silver, Gold" />
                      </label>
                    ) : null}

                    <div className="sw2-step-toggles">
                      <label className="sw2-check"><input type="checkbox" checked={f.required} onChange={(e) => patch(i, { required: e.target.checked })} /> Required</label>
                      <label className="sw2-check"><input type="checkbox" checked={f.active} onChange={(e) => patch(i, { active: e.target.checked })} /> Active</label>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="sw2-section">
            <div className="sw2-actions">
              <Link href="/app/admin/administration/work-types" className="adm-btn sw2-cancel">Back to work types</Link>
              <button type="submit" className="adm-btn adm-btn--primary sw2-start">Save fields</button>
            </div>
          </section>
        </form>
      </div>
    </div>
  );
}
