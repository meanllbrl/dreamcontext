import { Inventory } from './inventory.js';
import { load, save } from './store.js';
import { weeklyReport } from './report.js';
import { buildParcel } from './parcels.js';
import { formatQuantity } from './units.js';
import { expiryLabel } from './labels.js';

/** Run one CLI command against the data file; returns the text to print. */
export function run(argv: string[], dataPath: string, today: string): string {
  const [cmd, ...rest] = argv;
  const data = load(dataPath);
  const inventory = new Inventory(data.items);
  switch (cmd) {
    case 'list':
      return inventory
        .all()
        .map((i) => `${i.id}\t${i.name}\t${formatQuantity(i.quantity, i.unit)}\t${expiryLabel(i.expiresOn, today)}`)
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
      save(dataPath, { ...data, items: inventory.all() });
      return parcel.lines.map((l) => `${l.name}\t${formatQuantity(l.quantity, l.unit)}`).join('\n');
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
