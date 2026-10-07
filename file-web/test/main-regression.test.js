import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
const apiSource = await readFile(new URL('../src/api.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');

test('navigation requests ignore stale async responses', () => {
  assert.match(source, /const id=\+\+requestId\.current/);
  assert.match(source, /if\(id!==requestId\.current\)return false/);
  assert.match(source, /if\(id===requestId\.current\)setItems/);
});

test('clearing search reloads the active folder', () => {
  assert.match(source, /const clearSearch=\(\)=>\{setQuery\(''\);if\(source==='live'\)load\(active,currentFolder\)/);
  assert.match(source, /aria-label="Xóa tìm kiếm" onClick=\{clearSearch\}/);
});

test('dangerous and editable actions avoid native prompt dialogs', () => {
  assert.doesNotMatch(source, /\bprompt\s*\(/);
  assert.match(source, /role="dialog" aria-modal="true"/);
  assert.match(source, /label:'Hoàn tác',run:restore/);
});

test('download and notifications expose explicit states', () => {
  assert.match(source, /disabled=\{downloading\}/);
  assert.match(source, /toast\.type==='error'\?'alert':'status'/);
  assert.match(source, /formatDate\(item\.updated,item\.updated_at\)/);
});

test('mobile navigation has a real dismissible backdrop and keyboard focus management', () => {
  assert.match(source, /className="mobile-nav-backdrop" aria-label="Đóng menu điều hướng"/);
  assert.match(source, /if\(e\.key==='Escape'\)\{setMobileNav\(false\)/);
  assert.match(source, /keepFocusInside\(e,sidebar\.current\)/);
  assert.match(source, /aria-expanded=\{mobileNav\}/);
});

test('action dialogs trap and restore focus and close on Escape', () => {
  assert.match(source, /dialogRef\.current\?\.querySelector\('input,select,button'\)\?\.focus\(\)/);
  assert.match(source, /if\(e\.key==='Escape'\)\{close\(\)/);
  assert.match(source, /keepFocusInside\(e,dialogRef\.current\)/);
  assert.match(source, /if\(previous instanceof HTMLElement\)previous\.focus\(\)/);
});

test('action dialogs expose a layered modal contract for reliable pointer interaction', () => {
  assert.match(source, /className="dialog-backdrop"/);
  assert.match(source, /className="dialog"/);
  assert.match(source, /role="dialog" aria-modal="true"/);
  assert.match(source, /dialog-backdrop/);
  assert.match(source, /dialog-actions/);
  assert.match(styles, /\.dialog-backdrop\s*\{[^}]*position\s*:\s*fixed[^}]*inset\s*:\s*0[^}]*z-index\s*:\s*(?:[3-9]\d|\d{3,})/s, 'modal backdrop must cover the viewport above app chrome');
  assert.match(styles, /\.dialog\s*\{[^}]*max-(?:width|height)/s, 'dialog needs a responsive size boundary');
});

test('mobile drawer removes hidden navigation from the accessibility tree', () => {
  assert.match(source, /inert=|aria-hidden=\{!mobileNav\}/, 'closed drawer must be inert or aria-hidden');
  assert.match(source, /aria-label="Đóng menu điều hướng"/);
});

test('navigation and view controls expose current state semantics', () => {
  assert.match(source, /aria-current=(["']page|\{[^}]*active)/, 'active navigation needs aria-current');
  assert.match(source, /layout=\{grid\?'grid':'list'\}/, 'file manager receives the current list/grid layout');
  assert.match(source, /onLayoutChange=\{layout=>setGrid\(layout==='grid'\)\}/, 'file manager controls layout changes');
});

test('removed shell toolbar cannot reference unimported view icons at runtime', () => {
  assert.doesNotMatch(source, /<LayoutGrid\b|<List\b/);
});

test('file manager exposes list structure and consolidated overflow actions', () => {
  assert.match(source, /role=["'](table|grid|row|list)["']/i, 'file content needs an announced collection structure');
  assert.match(source, /aria-label=.*(Thêm|Tùy chọn|Hành động|overflow|menu)/i, 'file rows need an accessible overflow/action menu');
});

test('embedded file manager does not duplicate the Hippy navigation shell', () => {
  assert.match(source, /collapsibleNav=\{false\}/);
  assert.match(styles, /\.cubone-shell \.navigation-pane\{display:none!important\}/);
  assert.match(styles, /\.cubone-shell \.bread-crumb-container\{display:none\}/);
});

test('trash selection uses an explicit restore action instead of Cubone delete wording', () => {
  assert.match(source, /active==='trash'&&selectedIds\.length>0/);
  assert.match(source, /<CheckCircle2 size=\{16\}\/> Khôi phục/);
  assert.match(source, /delete:live&&active!=='trash'/);
});

test('quota details control has a real action contract', () => {
  const match = source.match(/className="storage-detail"[^>]*>/);
  assert.ok(match, 'quota detail control should remain discoverable');
  const start = source.indexOf(match[0]);
  const end = source.indexOf('</button>', start);
  const button = source.slice(start, end);
  assert.match(button, /onClick=/, 'quota detail control must not be a dead button');
});

test('admin users view displays total allocated file quota', () => {
  assert.match(source, /Tổng quota Files/);
  assert.match(source, /users\.reduce\(\(n, u\) => n \+ \(Number\(u\.quota_bytes\) \|\| 0\), 0\)/);
});

test('file actions preserve trash/restore and undo semantics', () => {
  assert.match(source, /active==='trash'/);
  assert.match(source, /Khôi phục/);
  assert.match(source, /label:'Hoàn tác',run:restore/);
});

test('sharing is outside MVP and visible actions use authoritative APIs', () => {
  assert.doesNotMatch(source, /\['shared',\s*'Được chia sẻ'/);
  assert.match(source, /fileApi\.previewBlob\(previewItem\.id\)/);
  assert.match(source, /fileApi\.download\(contextMenu\.item\)/);
  assert.match(source, /onClick=\{\(\) => trashItem\(detailsItem\)\}/);
  assert.doesNotMatch(source, /toggleStar\(detailsItem\.id\); notify\('Đã chuyển vào thùng rác'/);
  assert.match(source, /formatDate\(detailsItem\.created, detailsItem\.created_at\)/);
  assert.doesNotMatch(source, /20\/09\/2026, 08:30/);
});

test('stars, filters, cursors and activity come from the service', () => {
  assert.doesNotMatch(source, /setStarredIds/);
  assert.match(source, /fileApi\.star\(id, starred\)/);
  assert.match(source, /view === 'starred' \? \{starred: true\}/);
  assert.match(source, /fileApi\.nodes\(\{\.\.\.listParams, cursor:nextCursor\}\)/);
  assert.match(source, /fileApi\.activity\(detailsItem\.id\)/);
  assert.doesNotMatch(source, /<b>Đã tạo mục này<\/b>/);
});

test('version history exposes list, download and restore actions', () => {
  assert.match(source, /fileApi\.revisions\(detailsItem\.id\)/);
  assert.match(source, /fileApi\.revisionDownload\(detailsItem\.id, revision\.id/);
  assert.match(source, /fileApi\.restoreRevision\(detailsItem\.id, revision\.id/);
  assert.match(source, /aria-selected=\{detailsTab === 'revisions'\}/);
  assert.match(source, /Lịch sử phiên bản|Phiên bản/);
});

test('grid image cards lazy-load authenticated thumbnails with an icon fallback', () => {
  assert.match(source, /fileApi\.thumbnailBlob\(item\.id\)/);
  assert.match(source, /IntersectionObserver/);
  assert.match(source, /URL\.revokeObjectURL/);
  assert.match(source, /<Thumbnail item=\{file\} \/>/);
  assert.match(source, /isRasterImage/);
  assert.match(styles, /\.drive-grid-thumbnail/);
});

test('uploads expose continuous circular progress and duplicate-name choices', () => {
  assert.match(source, /function ProgressCircle\(/);
  assert.match(source, /upload-progress-circle/);
  assert.match(apiSource, /XMLHttpRequest/);
  assert.match(source, /Ghi đè/);
  assert.match(source, /Tạo phiên bản/);
  assert.match(source, /uploadConflict/);
  assert.match(source, /setTimeout\(closeUploadPanel, 5000\)/);
  assert.match(source, /upload-panel-closing/);
  assert.match(styles, /slideDownPanel/);
});

test('admin back action uses the dashboard button styling', () => {
  assert.match(source, /className="back"/);
  assert.match(styles, /\.admin-hero \.back/);
});

test('admin audit renders bounded structured rows and ignores stale tab responses', () => {
  assert.match(source, /function AdminAudit\(/);
  assert.match(source, /requestRef\.current/);
  assert.match(source, /events\.map\(event/);
  assert.match(source, /Tải thêm hoạt động/);
  assert.match(source, /fileApi\.audit\(\{limit: 25, cursor: data\.page\.next_cursor\}\)/);
  assert.match(styles, /\.admin-audit-list/);
});

test('admin tab changes keep each payload behind its expected schema', () => {
  assert.match(source, /const dataMatchesTab = tab === 'users'/);
  assert.match(source, /Array\.isArray\(data\?\.users\)/);
  assert.match(source, /!data \|\| !dataMatchesTab/);
  assert.match(source, /const users = dataMatchesTab && Array\.isArray\(data\?\.users\) \? data\.users : \[\]/);
});

test('unauthenticated users get a dedicated SSO screen instead of fake dashboard data', () => {
  assert.match(source, /source==='error' && \(error\?\.status===401 \|\| error\?\.code==='auth_required'\)/);
  assert.match(source, /function LoginScreen\(\{loginUrl\}\)/);
  assert.match(source, /Đăng nhập bằng Hippy SSO/);
  assert.match(source, /if\(source==='loading' && !me\) return <LoadingScreen/);
  assert.match(source, /if\(source==='error'\) return <ServiceError/);
  assert.doesNotMatch(source, /hippy<span className="brand-dot">\.<\/span>drive/);
});
