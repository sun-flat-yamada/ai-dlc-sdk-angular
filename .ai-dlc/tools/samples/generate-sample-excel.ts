/**
 * Generates the sample subsystem test specification workbook
 * (.ai-dlc/inputs/subsystem-tests/ST-NET-network-settings.xlsx) in the layout a QA team
 * typically uses. Elements are referenced as @ui-id (see ui-bindings.yaml).
 *
 *   npm run aidlc:sample-excel
 */
import path from 'node:path';
import ExcelJS from 'exceljs';
import { findRepoRoot, resolvePaths } from '../lib/config.js';
import { isMain, log, rel, runCli } from '../lib/cli.js';

const STATUS_READY =
  'GET /api/v1/status -> 200 {"deviceName":"Panel-01","firmwareVersion":"3.2.0","state":"ready","alerts":[]}';
const IPV4_STATIC =
  'GET /api/v1/network/ipv4 -> 200 {"dhcp":false,"address":"192.168.0.10","subnetMask":"255.255.255.0","gateway":"192.168.0.1"}';
const LINK_UP = 'GET /api/v1/network/link -> 200 {"link":"up","speedMbps":100}';
const LINK_DOWN = 'GET /api/v1/network/link -> 200 {"link":"down"}';
const PUT_OK =
  'PUT /api/v1/network/ipv4 -> 200 {"dhcp":false,"address":"192.168.0.20","subnetMask":"255.255.255.0","gateway":"192.168.0.1"}';
const lines = (...xs: string[]) => xs.join('\n');

export const SAMPLE_HEADERS = [
  'テストID',
  '大項目',
  'テスト項目',
  '優先度',
  '前提条件',
  '機器初期状態',
  'API応答(モック)',
  '操作手順',
  '期待画面表示',
  '期待CSS状態',
  '期待APIリクエスト',
  '備考',
] as const;

export const SAMPLE_ROWS: string[][] = [
  [
    'ST-NET-001',
    'ネットワーク設定',
    '初期表示で現在の設定とリンク状態が表示される',
    'A',
    'ホーム画面が表示されている',
    lines('state=ready', 'link=up', 'dhcp=false'),
    lines(STATUS_READY, IPV4_STATIC, LINK_UP),
    lines('1. /settings/network を開く'),
    lines(
      '@ip-address に 192.168.0.10 が表示される',
      '@subnet-mask に 255.255.255.0 が表示される',
      '@gateway に 192.168.0.1 が表示される',
      '@dhcp-toggle がオフである',
      '@link-label に「リンク: 接続」が表示される',
    ),
    lines('@link-led { background-color: rgb(47, 191, 113) }'),
    lines('GET /api/v1/network/ipv4', 'GET /api/v1/network/link'),
    'REQ-NET-002, REQ-NET-003',
  ],
  [
    'ST-NET-002',
    '',
    'DHCP を有効にすると手動入力欄が無効になる',
    'A',
    '',
    'state=ready',
    lines(STATUS_READY, IPV4_STATIC, LINK_UP),
    lines('1. /settings/network を開く', '2. @dhcp-toggle を押してオンにする'),
    lines(
      '@ip-address が無効（disabled）になる',
      '@subnet-mask が無効（disabled）になる',
      '@gateway が無効（disabled）になる',
    ),
    '',
    '',
    'REQ-NET-004',
  ],
  [
    'ST-NET-003',
    '',
    '静的 IP アドレスを変更して保存できる',
    'A',
    '',
    'state=ready',
    lines(STATUS_READY, IPV4_STATIC, LINK_UP, PUT_OK),
    lines(
      '1. /settings/network を開く',
      '2. @ip-address を 192.168.0.20 に書き換える',
      '3. @save-button を押す',
    ),
    lines('@status-message に「保存しました」が表示される'),
    lines('@status-message { color: rgb(47, 191, 113) }'),
    lines(
      'PUT /api/v1/network/ipv4 {"dhcp":false,"address":"192.168.0.20","subnetMask":"255.255.255.0","gateway":"192.168.0.1"}',
    ),
    'REQ-NET-006',
  ],
  [
    'ST-NET-004',
    '',
    '不正な IP アドレスは保存できない',
    'A',
    '',
    'state=ready',
    lines(STATUS_READY, IPV4_STATIC, LINK_UP),
    lines('1. /settings/network を開く', '2. @ip-address を 192.168.0.300 に書き換える'),
    lines(
      '@ip-address-error に「IPアドレスの形式が正しくありません」が表示される',
      '@save-button が無効（disabled）になる',
      'PUT /api/v1/network/ipv4 は送信されない',
    ),
    lines('@ip-address-error { color: rgb(255, 90, 90) }'),
    '',
    'REQ-NET-005',
  ],
  [
    'ST-NET-005',
    '',
    '機器の項目エラー(400)を該当項目に表示する',
    'B',
    '',
    'state=ready',
    lines(
      STATUS_READY,
      IPV4_STATIC,
      LINK_UP,
      'PUT /api/v1/network/ipv4 -> 400 {"message":"invalid","fieldErrors":{"gateway":"サブネット外のゲートウェイです"}}',
    ),
    lines(
      '1. /settings/network を開く',
      '2. @gateway を 10.0.0.1 に書き換える',
      '3. @save-button を押す',
    ),
    lines(
      '@gateway-error に「サブネット外のゲートウェイです」が表示される',
      '@gateway を再度編集できる',
    ),
    '',
    lines('PUT /api/v1/network/ipv4 {"gateway":"10.0.0.1"}'),
    'REQ-NET-007',
  ],
  [
    'ST-NET-006',
    '',
    '機器が動作中(503)の場合は警告を表示する',
    'B',
    '',
    'state=ready',
    lines(STATUS_READY, IPV4_STATIC, LINK_UP, 'PUT /api/v1/network/ipv4 -> 503 {"message":"busy"}'),
    lines('1. /settings/network を開く', '2. @save-button を押す'),
    lines('@status-message に「機器が動作中のため保存できません」が表示される'),
    lines('@status-message { color: rgb(255, 176, 32) }'),
    lines('PUT /api/v1/network/ipv4 {"dhcp":false,"address":"192.168.0.10"}'),
    'REQ-NET-008',
  ],
  [
    'ST-NET-007',
    '',
    'リンクダウン時は LED が赤になる',
    'B',
    '',
    lines('state=ready', 'link=down'),
    lines(STATUS_READY, IPV4_STATIC, LINK_DOWN),
    lines('1. /settings/network を開く'),
    lines('@link-label に「リンク: 切断」が表示される'),
    lines('@link-led { background-color: rgb(255, 90, 90) }'),
    lines('GET /api/v1/network/link'),
    'REQ-NET-003',
  ],
  [
    'ST-NET-008',
    '',
    'キャンセルでホーム画面に戻る',
    'C',
    '',
    'state=ready',
    lines(STATUS_READY, IPV4_STATIC, LINK_UP),
    lines('1. /settings/network を開く', '2. @cancel-button を押す'),
    lines('ホーム画面（URL が / ）に戻る'),
    '',
    '',
    'REQ-NET-009',
  ],
];

export async function buildSampleWorkbook(): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'ai-dlc-sdk-angular sample';
  workbook.created = new Date(Date.UTC(2026, 10, 1));
  workbook.modified = workbook.created;

  const cover = workbook.addWorksheet('表紙');
  cover.addRows([
    ['サブシステムテスト仕様書（サンプル）'],
    ['対象', 'ネットワーク設定画面（REQ-NET）'],
    ['記法', '画面要素は @ui-id（ui-bindings.yaml の要素 ID）で参照する'],
    [
      '記法',
      'API応答: "METHOD /path -> status {json}" / 期待APIリクエスト: "METHOD /path {json の部分一致}"',
    ],
  ]);
  cover.getColumn(1).width = 16;
  cover.getColumn(2).width = 90;

  const sheet = workbook.addWorksheet('ネットワーク設定');
  sheet.addRow(['ネットワーク設定 サブシステムテスト']);
  sheet.addRow([]);
  const header = sheet.addRow([...SAMPLE_HEADERS]);
  header.font = { bold: true };
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };
    cell.border = { bottom: { style: 'thin' } };
  });
  for (const row of SAMPLE_ROWS) {
    const added = sheet.addRow(row);
    added.alignment = { wrapText: true, vertical: 'top' };
  }
  const widths = [12, 16, 36, 8, 22, 16, 60, 40, 50, 40, 60, 20];
  widths.forEach((w, i) => (sheet.getColumn(i + 1).width = w));
  sheet.views = [{ state: 'frozen', ySplit: 3 }];
  return workbook;
}

async function main(): Promise<number> {
  const paths = resolvePaths(findRepoRoot());
  const file = path.join(paths.inputs.subsystemTests, 'ST-NET-network-settings.xlsx');
  const workbook = await buildSampleWorkbook();
  await workbook.xlsx.writeFile(file);
  log.info(`Wrote ${rel(paths.root, file)} (${SAMPLE_ROWS.length} cases)`);
  return 0;
}

if (isMain(import.meta.url)) {
  runCli(main);
}
