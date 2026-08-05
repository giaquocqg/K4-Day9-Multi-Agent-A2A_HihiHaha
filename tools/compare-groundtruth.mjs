import fs from 'node:fs';
import path from 'node:path';

const [actualDir, expectedDir, flag] = process.argv.slice(2);
if (!actualDir || !expectedDir) {
    console.error('Usage: node tools/compare-groundtruth.mjs <actual-dir> <expected-dir> [--strict]');
    process.exit(2);
}

const files = fs.readdirSync(expectedDir).filter(name => /^EC_\d{3}\.json$/.test(name)).sort();
const diffs = [];

function compare(actual, expected, jsonPath, file) {
    if (Object.is(actual, expected)) return;
    if (Array.isArray(actual) && Array.isArray(expected)) {
        if (actual.length !== expected.length) {
            diffs.push({ file, path: `${jsonPath}.length`, actual: actual.length, expected: expected.length });
        }
        for (let i = 0; i < Math.max(actual.length, expected.length); i++) {
            compare(actual[i], expected[i], `${jsonPath}[${i}]`, file);
        }
        return;
    }
    if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
        const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
        for (const key of [...keys].sort()) compare(actual[key], expected[key], `${jsonPath}.${key}`, file);
        return;
    }
    diffs.push({ file, path: jsonPath, actual, expected });
}

for (const file of files) {
    const actualPath = path.join(actualDir, file);
    if (!fs.existsSync(actualPath)) {
        diffs.push({ file, path: '$', actual: '<missing file>', expected: '<present>' });
        continue;
    }
    compare(
        JSON.parse(fs.readFileSync(actualPath, 'utf8')),
        JSON.parse(fs.readFileSync(path.join(expectedDir, file), 'utf8')),
        '$',
        file,
    );
}

const byPath = new Map();
for (const diff of diffs) byPath.set(diff.path, (byPath.get(diff.path) || 0) + 1);

console.log(`${files.length} expected files, ${diffs.length} value mismatches`);
for (const [jsonPath, count] of [...byPath.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    console.log(`  ${count}x ${jsonPath}`);
}
for (const diff of diffs.slice(0, 20)) {
    console.log(`  ${diff.file} ${diff.path}: actual=${JSON.stringify(diff.actual)} expected=${JSON.stringify(diff.expected)}`);
}

if (flag === '--strict' && diffs.length > 0) process.exit(1);
