// People bulk selection — what is checked, what the bar says, and what a bulk
// action receives are one set.
//
// Regression for the live preview: selecting two rows showed no bar; Select All
// showed "25 selected"; unchecking one row left 24 checked while the bar still
// said 25 -- and still carried all 25 IDs, so Apply would have written to the
// person the table showed as unselected. The old bar attached change listeners
// once, to whatever checkbox nodes existed when it mounted.
//
// The checkboxes and the bar now read one React selection that changes only
// through src/crm/bulk-selection.ts. These tests drive that model through the
// same sequences a person clicks, render the bar and the controls for the
// resulting selection, and pin the wiring on the page and in the actions. (The
// dev environment has no DOM library; the click-through is also verified in a
// real browser before merge.)

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  allSelected, formatBulkIds, parseBulkIds, partlySelected, selectedIds, toggleAll, toggleRow, type Picked,
} from '../src/crm/bulk-selection';
import { BulkBarView, BulkSelection, RowCheckbox, SelectAllCheckbox } from '../src/app/crm/customers/bulk-bar';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const code = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const render = (el: unknown) => renderToStaticMarkup(el as never);

const ROWS = Array.from({ length: 25 }, (_, i) => `cust_${String(i + 1).padStart(2, '0')}`);
const STATUSES = ['New', 'Contacted', 'Quoted', 'Booked', 'Completed', 'Archived'];
const NONE: Picked = new Set();

/** What a person sees and what Apply would post, for a selection. */
function observe(picked: Picked, rows = ROWS) {
  const selected = selectedIds(picked, rows);
  const html = render(<BulkBarView selected={selected} tags={['VIP']} statuses={STATUSES} />);
  const posted = [...html.matchAll(/<input type="hidden" name="ids" value="([^"]*)"\/>/g)].map((m) => parseBulkIds(m[1]));
  return {
    checked: rows.filter((id) => picked.has(id)),
    barShown: html.includes('crm-bulkbar'),
    count: html.match(/<span class="crm-bulk-count">(\d+) selected<\/span>/)?.[1] ?? null,
    posted,
    selectAll: allSelected(picked, rows) ? 'checked' : partlySelected(picked, rows) ? 'indeterminate' : 'unchecked',
  };
}

describe('People bulk selection', () => {
  it('partial selection: two rows checked shows the bar with 2, and posts exactly those two', () => {
    let picked = toggleRow(NONE, ROWS, 'cust_03');
    picked = toggleRow(picked, ROWS, 'cust_07');
    const seen = observe(picked);
    assert.deepEqual(seen.checked, ['cust_03', 'cust_07']);
    assert.equal(seen.barShown, true);
    assert.equal(seen.count, '2');
    assert.deepEqual(seen.posted, [['cust_03', 'cust_07'], ['cust_03', 'cust_07'], ['cust_03', 'cust_07']], 'every bulk form');
    assert.equal(seen.selectAll, 'indeterminate');
  });

  it('select all: every row on screen, the bar says 25, all 25 are posted', () => {
    const seen = observe(toggleAll(NONE, ROWS));
    assert.equal(seen.checked.length, 25);
    assert.equal(seen.count, '25');
    for (const ids of seen.posted) assert.deepEqual(ids, ROWS);
    assert.equal(seen.selectAll, 'checked');
  });

  it('deselect after select all: 24 checked, the bar says 24, and the unchecked row is not posted', () => {
    const seen = observe(toggleRow(toggleAll(NONE, ROWS), ROWS, 'cust_12'));
    assert.equal(seen.checked.length, 24);
    assert.equal(seen.count, '24');
    for (const ids of seen.posted) {
      assert.equal(ids.length, 24);
      assert.equal(ids.includes('cust_12'), false, 'the row the table shows unchecked is never written');
      assert.deepEqual(ids, seen.checked);
    }
    assert.equal(seen.selectAll, 'indeterminate');
  });

  it('the displayed count always equals the checked rows and the posted IDs, across any click sequence', () => {
    let picked: Picked = NONE;
    const clicks = ['cust_01', 'ALL', 'cust_05', 'cust_05', 'cust_09', 'ALL', 'ALL', 'cust_25', 'cust_01', 'cust_25'];
    for (const click of clicks) {
      picked = click === 'ALL' ? toggleAll(picked, ROWS) : toggleRow(picked, ROWS, click);
      const seen = observe(picked);
      assert.equal(seen.barShown, seen.checked.length > 0, `after ${click}`);
      assert.equal(seen.count, seen.checked.length > 0 ? String(seen.checked.length) : null, `after ${click}`);
      for (const ids of seen.posted) assert.deepEqual(ids, seen.checked, `after ${click}`);
    }
  });

  it('select all again when everything is selected clears the selection and hides the bar', () => {
    const seen = observe(toggleAll(toggleAll(NONE, ROWS), ROWS));
    assert.deepEqual(seen.checked, []);
    assert.equal(seen.barShown, false);
    assert.deepEqual(seen.posted, []);
  });

  it('a row that is not on screen can never be selected or posted', () => {
    const picked = toggleRow(toggleAll(NONE, ROWS), ROWS, 'cust_from_another_page');
    assert.deepEqual(selectedIds(picked, ROWS), ROWS);
    // A new page of rows: nothing carried over from the old one is shown or posted.
    const nextPage = ['cust_26', 'cust_27'];
    const seen = observe(picked, nextPage);
    assert.deepEqual(seen.checked, []);
    assert.equal(seen.barShown, false);
  });

  it('the posted field reads back as exactly the selection: each ID once, nothing empty', () => {
    assert.deepEqual(parseBulkIds(formatBulkIds(['a', 'b', 'c'])), ['a', 'b', 'c']);
    assert.deepEqual(parseBulkIds(' a, ,b,a ,, c '), ['a', 'b', 'c']);
    assert.deepEqual(parseBulkIds(null), []);
    assert.deepEqual(parseBulkIds(''), []);
  });
});

describe('The People page uses that selection, and only it', () => {
  it('controls render inside one provider with nothing selected and no bar', () => {
    const html = render(
      <BulkSelection rowIds={['c1', 'c2']}>
        <SelectAllCheckbox />
        <RowCheckbox id="c1" name="Alex" />
        <RowCheckbox id="c2" name="Blair" />
      </BulkSelection>,
    );
    assert.match(html, /<input type="checkbox" aria-label="Select all"\/>/);
    assert.match(html, /<input type="checkbox" aria-label="Select Alex"\/>/);
    assert.equal(html.includes('checked'), false);
    assert.equal(html.includes('crm-bulkbar'), false);
  });

  it('the page keys the selection by the rows on screen and renders every box from it', () => {
    const page = code(read('../src/app/crm/customers/page.tsx'));
    assert.match(page, /<BulkSelection key=\{list\.rows\.map\(\(c\) => c\.id\)\.join\(','\)\} rowIds=\{list\.rows\.map\(\(c\) => c\.id\)\}>/);
    assert.match(page, /<SelectAllCheckbox \/>/);
    assert.match(page, /<RowCheckbox id=\{c\.id\} name=\{c\.name\} \/>/);
    assert.equal(/data-bulk-row|data-bulk-all|type="checkbox"/.test(page), false, 'no unmanaged checkbox is left for a DOM listener to miss');
    const bar = code(read('../src/app/crm/customers/bulk-bar.tsx'));
    assert.equal(/document\.|querySelector|addEventListener/.test(bar), false, 'selection is not read from the DOM');
    for (const fn of ['toggleRow(current, rowIds, id)', 'toggleAll(current, rowIds)', 'selectedIds(picked, rowIds)']) {
      assert.ok(bar.includes(fn), `the component changes selection only through ${fn}`);
    }
  });

  it('bulk actions read the posted IDs with the same model, and still authorize and scope on the server', () => {
    const actions = code(read('../src/crm/actions.ts'));
    assert.match(actions, /function parseIds\(formData: FormData\): string\[\] \{\s*return parseBulkIds\(formData\.get\('ids'\)\);\s*\}/);
    for (const [fn, perm] of [['bulkSetStatusAction', "requirePermission('pipeline', 'update')"], ['bulkAddTagAction', "requirePermission('customers', 'update')"], ['bulkAssignAction', "requirePermission('customers', 'update')"]] as const) {
      const body = actions.slice(actions.indexOf(`export async function ${fn}`), actions.indexOf('\n}', actions.indexOf(`export async function ${fn}`)));
      assert.match(body, /const ids = parseIds\(formData\);/, fn);
      assert.ok(body.includes(perm), `${fn} authorizes`);
      assert.match(body, /const \{ organizationId \} = await requireCrmContext\(\);/, `${fn} takes the organization from the session`);
    }
  });
});
