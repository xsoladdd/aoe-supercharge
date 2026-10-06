/**
 * Medieval names for workers. They read better than task numbers, and later they become the
 * characters walking around the office view. The task id stays next to the name everywhere.
 */
export const WORKER_NAMES = [
  'Arthur',
  'Gareth',
  'Godfrey',
  'Gawain',
  'Percival',
  'Lancelot',
  'Tristan',
  'Galahad',
  'Bedivere',
  'Lionel',
  'Ector',
  'Kay',
  'Bors',
  'Lamorak',
  'Pellinore',
  'Yvain',
  'Geraint',
  'Dagonet',
  'Roland',
  'Oliver',
  'Baldwin',
  'Tancred',
  'Bohemond',
  'Geoffrey',
  'Hugh',
  'Odo',
  'Walter',
  'Wulfric',
  'Aldric',
  'Edric',
  'Osric',
  'Cedric',
  'Leofric',
  'Godwin',
  'Harold',
  'Alfred',
  'Edmund',
  'Edgar',
  'Athelstan',
  'Oswald',
  'Ranulf',
  'Reginald',
  'Roger',
  'Simon',
  'Thibault',
  'Guy',
  'Amaury',
  'Aymer',
  'Bertrand',
  'Eustace',
  'Fulk',
  'Gilbert',
  'Humphrey',
  'Ivo',
  'Lambert',
  'Milo',
  'Piers',
  'Ralph',
  'Robert',
  'Stephen',
  'William',
  'Aldous',
  'Anselm',
  'Benedict',
  'Conrad',
  'Drogo',
  'Everard',
  'Gervase',
  'Hamon',
  'Jasper',
  'Leopold',
  'Merrick',
  'Norbert',
  'Osbert',
  'Quentin',
  'Rufus',
  'Sigmund',
  'Theobald',
  'Ulric',
  'Warin',
  'Alaric',
  'Caradoc',
  'Dunstan',
  'Elric',
  'Florian',
  'Garrick',
  'Hereward',
  'Isembard',
  'Jocelin',
  'Lothar',
  'Matthias',
  'Orrin',
  'Rainald',
  'Sebastian',
  'Thorold',
  'Urien',
  'Wystan',
  'Guinevere',
  'Isolde',
  'Elaine',
  'Enid',
  'Lynette',
  'Vivian',
  'Rowena',
  'Matilda',
  'Eleanor',
  'Isabella',
  'Adela',
  'Agnes',
  'Alys',
  'Beatrice',
  'Cecily',
  'Edith',
  'Emma',
  'Gwendolyn',
  'Hawise',
  'Ida',
  'Joan',
  'Margery',
  'Maud',
  'Rohese',
  'Sybil',
  'Aveline',
  'Blanche',
  'Constance',
  'Eloise',
  'Felicia',
  'Gisela',
  'Helewise',
  'Imogen',
  'Juliana',
  'Katherine',
  'Mabel',
  'Nesta',
  'Odelina',
  'Petronella',
  'Rosamund',
  'Sabina',
  'Ursula',
  'Elspeth',
  'Brunhild',
  'Godiva',
  'Ermengarde',
  'Melisende',
  'Avice',
  'Christiana',
  'Dionisia',
  'Estrild',
  'Lunete',
  'Nimue',
  'Igraine',
] as const;

const ROMAN = ['II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * A name no worker in the project has had yet (removed ones included, so a restored worker never
 * clashes), in an order that differs per project. Once every name is taken, "Arthur II" and so on.
 */
export function pickWorkerName(taken: Iterable<string>, project: string): string {
  const used = new Set(taken);
  const order = [...WORKER_NAMES].sort((a, b) => fnv1a(`${project}:${a}`) - fnv1a(`${project}:${b}`));
  for (const suffix of ['', ...ROMAN.map((r) => ` ${r}`)]) {
    const free = order.find((n) => !used.has(`${n}${suffix}`));
    if (free) return `${free}${suffix}`;
  }
  return `${order[0]} ${used.size + 1}`;
}

/** "Gareth" for named workers, the task id for older ones. */
export function workerName(task: { id: string; name?: string | null }): string {
  return task.name || task.id;
}

/** "Gareth (CB-0007)": the name with the id kept beside it. */
export function workerLabel(task: { id: string; name?: string | null }): string {
  return task.name ? `${task.name} (${task.id})` : task.id;
}
