// Loop Intelligence PR 2 (the fabric), 2026-09-26: the domain registry agrees with the navigation.
//
// Every surface a domain names is a real destination in LOOP_NAV (or a page inside one), and the read
// authority the registry states is exactly the authority that destination enforces. A domain can
// therefore never claim a page that does not exist, and a future surface that reads a domain's
// intelligence knows which permission to check -- the same one the rail already checks.
// Every Home tile a domain names is one of Home's tiles.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INTELLIGENCE_DOMAIN_REGISTRY } from '@emgloop/shared';
import { LOOP_NAV } from '../src/workspaces/config';
import { TILE_PATHS } from '../src/app/app/_home/tiles';

const items = LOOP_NAV.nav.flatMap((g) => g.items);

test('every domain surface is a LOOP_NAV destination (or inside one), with the same read authority', () => {
  for (const d of INTELLIGENCE_DOMAIN_REGISTRY) {
    for (const surface of d.surfaces) {
      const item = items.find((i) => i.href === surface) ?? items.filter((i) => surface.startsWith(i.href + '/')).sort((a, b) => b.href.length - a.href.length)[0];
      assert.ok(item, `${d.domain}: ${surface} is in the navigation`);
      const requires = item!.requires ? `${item!.requires.resource}:${item!.requires.action}` : null;
      assert.equal(d.readAuthority.permission, requires, `${d.domain}: ${surface} enforces ${requires}`);
      assert.equal(d.readAuthority.workspace, (item as { workspace?: string }).workspace ?? null, `${d.domain}: ${surface} workspace`);
    }
  }
});

test('every Home tile a domain names is one of Home\'s tiles, and its path is a surface of that domain', () => {
  const tileHref: Record<string, readonly string[]> = {
    mail: [TILE_PATHS.mail],
    chats: [TILE_PATHS.chats],
    calendar: [TILE_PATHS.calendar],
    work: [TILE_PATHS.adminWork, TILE_PATHS.employeeWork],
    intake: [TILE_PATHS.intake],
    callgrid: [TILE_PATHS.marketplace],
    campaigns: [TILE_PATHS.campaigns],
    creators: [TILE_PATHS.creators],
  };
  for (const d of INTELLIGENCE_DOMAIN_REGISTRY) {
    if (d.home.tile === null) continue;
    const hrefs = tileHref[d.home.tile];
    assert.ok(hrefs, `${d.domain}: ${d.home.tile} is a Home tile`);
    assert.ok(hrefs!.some((h) => d.surfaces.includes(h)), `${d.domain}: its Home tile leads to one of its surfaces`);
  }
});
