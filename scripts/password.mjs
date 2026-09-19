import { randomBytes, scryptSync } from 'node:crypto';

if (!process.stdin.isTTY) throw new Error('请在交互终端执行 npm run password。');
process.stdout.write('输入访问密码（至少 16 位，输入不回显）：');
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
let password = '';
process.stdin.on('data', chunk => {
  for (const char of chunk) {
    if (char === '\u0003') { process.stdin.setRawMode(false); process.exit(130); }
    if (char === '\r' || char === '\n') {
      process.stdin.setRawMode(false);
      if (password.length < 16 || password.length > 256) { console.error('\n密码必须为 16–256 位。'); process.exit(1); }
      const salt = randomBytes(16).toString('hex');
      console.log(`\nPASSWORD_HASH=${salt}:${scryptSync(password, salt, 64).toString('hex')}`);
      process.exit(0);
    }
    if (char === '\u007f') password = [...password].slice(0, -1).join('');
    else if (char >= ' ') password += char;
  }
});
