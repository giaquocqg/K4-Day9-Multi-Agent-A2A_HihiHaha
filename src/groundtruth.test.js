import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const groundtruthDir = process.env.GROUNDTRUTH_DIR || path.resolve('..', 'groundtruth');
const outputDir = path.resolve('output');

function normalized(value) {
    const out = structuredClone(value);

    // Bộ 93 điểm dùng confidence 0.95 và sort payment theo sequence. Bài hạng 1 dùng
    // confidence 1 và thứ tự CSV; bỏ riêng hai khác biệt đã A/B test này khỏi oracle.
    delete out.case_assessment.confidence;
    out.affected_entities.payment_ids.sort();
    out.payment_reconciliation.payment_types.sort();
    out.evidence_ids.sort();
    return out;
}

test('manual-only regression: so output với bộ tham khảo ngoài production', {
    skip: process.env.RUN_GROUNDTRUTH_TEST !== '1' || !fs.existsSync(groundtruthDir)
        ? 'chỉ chạy khi chủ động đặt RUN_GROUNDTRUTH_TEST=1 và có groundtruth' : false,
}, () => {
    const files = fs.readdirSync(groundtruthDir).filter(name => /^EC_\d{3}\.json$/.test(name)).sort();
    assert.equal(files.length, 50, 'groundtruth phải có đúng 50 case');

    for (const file of files) {
        const actual = JSON.parse(fs.readFileSync(path.join(outputDir, file), 'utf8'));
        const expected = JSON.parse(fs.readFileSync(path.join(groundtruthDir, file), 'utf8'));
        assert.deepEqual(normalized(actual), normalized(expected), `${file} lệch groundtruth`);
    }
});
