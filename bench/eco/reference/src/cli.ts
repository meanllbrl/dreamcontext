import { Inventory } from './inventory.js';
import { load, save } from './store.js';
import { weeklyReport } from './report.js';
import { buildParcel } from './parcels.js';
import { formatQuantity } from './units.js';
import { toCsv } from './export.js';
import { searchItems } from './search.js';

/** Run one CLI command against the data file; returns the text to print. */
export function run(argv: string[], dataPath: string, today: string): string {
  const [cmd, ...rest] = argv;
  const data = load(dataPath);
  const inventory = new Inventory(data.items, data.reservations ?? []);
  const line = (i: { id: string; name: string; quantity: number; unit: any; expiresOn: string | null }) => `${i.id}\t${i.name}\t${formatQuantity(i.quantity, i.unit)}\t${i.expiresOn ?? '-'}`;
  switch (cmd) {
    case 'list':
      return inventory
        .all()
        .map((i) => `${i.id}\t${i.name}\t${formatQuantity(i.quantity, i.unit)}\t${i.expiresOn ?? '-'}`)
        .join('\n');
    case 'expiring': {
      const days = flag(rest, '--days', 3);
      return inventory
        .expiringSoon(today, days)
        .map((i) => `${i.name}\t${i.expiresOn}`)
        .join('\n');
    }
    case 'report':
      return weeklyReport(inventory, { today });
    case 'parcel': {
      const household = data.households.find((h) => h.id === rest[0]);
      if (!household) throw new Error(`unknown household ${rest[0]}`);
      const parcel = buildParcel(household, inventory, today);
      save(dataPath, { ...data, items: inventory.all(), reservations: inventory.reservations() });
      return parcel.lines.map((l) => `${l.name}\t${formatQuantity(l.quantity, l.unit)}`).join('\n');
    }
    case 'export':
      return toCsv(inventory.all());
    case 'search': {
      const hits = searchItems(inventory.all(), rest[0] ?? '');
      return hits.length ? hits.map(line).join('\n') : 'no match';
    }
    case 'reserve': {
      inventory.reserve(rest[0], rest[1], Number(rest[2]), new Date().toISOString());
      save(dataPath, { ...data, items: inventory.all(), reservations: inventory.reservations() });
      return `reserved ${rest[2]} of ${rest[1]} for ${rest[0]}`;
    }
    case 'release': {
      const n = inventory.release(rest[0], rest[1]);
      save(dataPath, { ...data, items: inventory.all(), reservations: inventory.reservations() });
      return `released ${n} of ${rest[1]} for ${rest[0]}`;
    }
    default:
      throw new Error(`unknown command ${cmd ?? '(none)'}`);
  }
}

function flag(args: string[], name: string, fallback: number): number {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const n = Number(args[i + 1]);
  if (!Number.isFinite(n)) throw new Error(`${name} needs a number`);
  return n;
}
