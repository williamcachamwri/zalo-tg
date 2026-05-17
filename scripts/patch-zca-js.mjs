import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const files = [
  'node_modules/zca-js/dist/apis/sendMessage.js',
  'node_modules/zca-js/dist/cjs/apis/sendMessage.cjs',
];

const before = 'qmsgAttach: isGroupMessage ? JSON.stringify(prepareQMSGAttach(quote)) : undefined';
const after = 'qmsgAttach: JSON.stringify(prepareQMSGAttach(quote))';

let patched = 0;
for (const file of files) {
  if (!existsSync(file)) {
    console.warn(`[patch-zca-js] Bỏ qua ${file}: không tồn tại`);
    continue;
  }

  const source = readFileSync(file, 'utf8');
  if (source.includes(after)) {
    continue;
  }
  if (!source.includes(before)) {
    throw new Error(`[patch-zca-js] Không tìm thấy đoạn cần vá trong ${file}. Có thể zca-js đã đổi API sendMessage.`);
  }

  writeFileSync(file, source.replace(before, after));
  patched += 1;
}

if (patched > 0) {
  console.log(`[patch-zca-js] Đã vá qmsgAttach cho ${patched} file.`);
}
