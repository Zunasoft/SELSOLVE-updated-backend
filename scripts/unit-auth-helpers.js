/**
 * Unit tests for the pure helpers exported from auth.js.
 *
 * These are the pieces of the Super Admin OTP flow that don't need the
 * master database or a running server, so unlike the e2e-*.js scripts in
 * this folder, this one runs standalone:
 *
 *   node scripts/unit-auth-helpers.js
 */

const crypto = require('crypto');
const { hashOtp, generateOtp, normalizeEmail } = require('../auth');

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const section = (name) => console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 58 - name.length))}`);

function run() {
  section('normalizeEmail');

  check('Trims surrounding whitespace', normalizeEmail('  a@b.com  ') === 'a@b.com');
  check('Lower-cases the address', normalizeEmail('Zuna@Example.COM') === 'zuna@example.com');
  check('null becomes an empty string', normalizeEmail(null) === '');
  check('undefined becomes an empty string', normalizeEmail(undefined) === '');

  section('generateOtp');

  const otp = generateOtp();
  check('Returns a string', typeof otp === 'string', `typeof ${typeof otp}`);
  check('Is exactly 6 digits', /^\d{6}$/.test(otp), otp);
  check('Falls within the 100000–999999 range', Number(otp) >= 100000 && Number(otp) <= 999999, otp);

  const sample = new Set(Array.from({ length: 50 }, () => generateOtp()));
  check('Repeated calls are not all identical', sample.size > 1, `${sample.size} unique of 50`);

  section('hashOtp');

  check('Is deterministic for the same input', hashOtp('123456') === hashOtp('123456'));
  check('Differs for a different code', hashOtp('123456') !== hashOtp('654321'));
  check('Matches a manual sha256 digest', hashOtp('123456') === crypto.createHash('sha256').update('123456').digest('hex'));
  check('Accepts a number the same way as its string form', hashOtp(123456) === hashOtp('123456'));

  console.log(`\n${'═'.repeat(64)}`);
  console.log(`  ${passed} passed · ${failed} failed`);
  if (failed) {
    console.log('\n  Failing checks:');
    failures.forEach((f) => console.log(`    · ${f}`));
  }
  console.log(`${'═'.repeat(64)}\n`);

  return failed;
}

process.exit(run() ? 1 : 0);
