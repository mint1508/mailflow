function parseCsvLine(line) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && line[index + 1] === '"' && quoted) { cell += '"'; index += 1; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (character === ',' && !quoted) { cells.push(cell.trim()); cell = ''; continue; }
    cell += character;
  }
  cells.push(cell.trim());
  return cells;
}

export function parseCpanelBulkRows(text, mode = 'bulk') {
  const rows = String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(parseCsvLine);
  if (!rows.length) return [];
  const first = rows[0].map(value => value.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const headerNames = new Set(['localpart', 'email', 'user', 'password', 'quotamb', 'quota']);
  const hasHeader = mode === 'csv' && first.some(value => headerNames.has(value));
  const headers = hasHeader ? first : ['localpart', 'password', 'quotamb'];
  const sourceRows = hasHeader ? rows.slice(1) : rows;
  return sourceRows.map(cells => {
    const item = {};
    headers.forEach((header, index) => {
      if (cells[index]) {
        const key = header === 'localpart' ? 'localPart' : header === 'quotamb' || header === 'quota' ? 'quotaMb' : header;
        item[key] = cells[index];
      }
    });
    return item;
  }).filter(item => item.localPart || item.email || item.user);
}
