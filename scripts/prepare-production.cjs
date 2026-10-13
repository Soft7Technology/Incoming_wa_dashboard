#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const policy = JSON.parse(fs.readFileSync(path.join(root, 'production-files.json'), 'utf8'));
const args = new Set(process.argv.slice(2));
const check = args.has('--check');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const matches = (file, entry) => entry.endsWith('/') ? file.startsWith(entry) : file === entry;
const forbidden = file => policy.devOnly.some(entry => matches(file, entry))
  || policy.scratchFiles.includes(file)
  || file.split('/').some(part => policy.runtimeDirectories.includes(part))
  || /(^|\/)\.env/.test(file) && !file.endsWith('.env.example')
  || /\.(?:test|spec)\.(?:cjs|mjs|js|ts|tsx)$/.test(file)
  || /\.postman_(?:collection|environment)\.json$/.test(file);
const tracked = () => [...new Set(git('ls-files', '-z').split('\0').filter(Boolean))];
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const write = (file, value) => fs.writeFileSync(path.join(root, file), value);

function validate() {
  const problems = tracked().filter(forbidden).map(file => `Development or runtime file is tracked: ${file}`);
  if (git('diff', '--name-only', '--diff-filter=U').trim()) problems.push('Unresolved merge conflicts remain.');
  // Inspect the index so CI and local staged-release checks agree.
  const pkg = JSON.parse(git('show', ':package.json'));
  for (const [name, command] of Object.entries(pkg.scripts)) {
    if (/^test(?::|$)/.test(name) || /facebook-login-test|\btests\//.test(command)) {
      problems.push(`Development command remains in package.json: ${name}`);
    }
  }
  if (pkg.scripts.knex !== 'knex --knexfile dist/library/surefy/src/config/knex.config.js') {
    problems.push('Production migrations must use the compiled Knex configuration.');
  }
  if (/FacebookLoginTestRoute|['"]\/login-test['"]/.test(git('show', ':src/routes/facebookPublic.route.ts'))) {
    problems.push('The development Facebook login test route is still mounted.');
  }
  if (!git('show', ':.gitignore').includes('# BEGIN MAIN-ONLY FILES')) {
    problems.push('Main-only ignore rules are missing. Run prepare:production on main.');
  }
  if (problems.length) throw new Error(problems.join('\n'));
  console.info('Production file check passed. Tests, Postman, demo pages and runtime artifacts are excluded.');
}

function prepare() {
  if (git('branch', '--show-current').trim() !== 'main') {
    throw new Error('Preparation runs only on main. Use a separate main worktree to preserve dev files.');
  }
  if (!args.has('--allow-dirty') && git('status', '--porcelain').trim()) {
    throw new Error('Worktree has uncommitted changes. Commit them first, or use --allow-dirty for a pending release merge.');
  }
  // Validate every removal target before invoking Git. All arguments are passed without a shell.
  const removing = tracked().filter(forbidden);
  for (const file of removing) {
    const resolved = path.resolve(root, file);
    if (!resolved.startsWith(root + path.sep)) throw new Error(`Unsafe removal target: ${file}`);
  }
  // Parse before removing anything; unresolved package/route conflicts need manual resolution.
  const pkg = JSON.parse(read('package.json'));
  const route = read('src/routes/facebookPublic.route.ts');
  for (const file of ['src/routes/facebookPublic.route.ts', '.gitignore', 'docs/company-payments.md', 'docs/superadmin-api.md']) {
    if (fs.existsSync(path.join(root, file)) && /^(?:<<<<<<<|=======|>>>>>>>)/m.test(read(file))) {
      throw new Error(`Resolve the ${file} merge conflict first.`);
    }
  }
  for (let offset = 0; offset < removing.length; offset += 40) {
    git('rm', '-f', '--', ...removing.slice(offset, offset + 40));
  }
  for (const [name, command] of Object.entries(pkg.scripts)) {
    if (/^test(?::|$)/.test(name) || /facebook-login-test|\btests\//.test(command)) delete pkg.scripts[name];
  }
  pkg.scripts.knex = 'knex --knexfile dist/library/surefy/src/config/knex.config.js';
  write('package.json', JSON.stringify(pkg, null, 2) + '\n');
  write('src/routes/facebookPublic.route.ts', route
    .replace(/^import FacebookLoginTestRoute[^\n]*\r?\n/m, '')
    .replace(/^route\.use\('\/login-test', FacebookLoginTestRoute\);\r?\n/m, ''));
  const ignored = read('.gitignore').replace(/\n?# BEGIN MAIN-ONLY FILES[\s\S]*?# END MAIN-ONLY FILES\r?\n?/g, '').trimEnd();
  write('.gitignore', ignored + '\n\n# BEGIN MAIN-ONLY FILES\n'
    + policy.devOnly.map(entry => '/' + entry).join('\n')
    + '\n*.test.cjs\n*.test.mjs\n*.test.js\n*.test.ts\n*.test.tsx\n*.spec.cjs\n*.spec.mjs\n*.spec.js\n*.spec.ts\n*.spec.tsx\n*.postman_collection.json\n*.postman_environment.json\n# END MAIN-ONLY FILES\n');
  // Keep API instructions but point examples at the branch that contains them.
  const exampleDocs = ['docs/company-payments.md', 'docs/superadmin-api.md'];
  for (const file of exampleDocs) {
    if (!fs.existsSync(path.join(root, file))) continue;
    let content = read(file);
    if (!content.includes('Development examples are kept on the `dev` branch.')) {
      content = 'Development examples are kept on the `dev` branch. Test pages and Postman collections are not deployed from main.\n\n' + content;
    }
    content = content
      .replace(/\]\(payment-test\.html\)/g, '](https://github.com/Soft7Technology/Incoming_wa_dashboard/blob/dev/docs/payment-test.html)')
      .replace(/\]\(subscription-checkout\.html\)/g, '](https://github.com/Soft7Technology/Incoming_wa_dashboard/blob/dev/docs/subscription-checkout.html)');
    write(file, content);
  }
  git('add', '--', 'package.json', '.gitignore', 'src/routes/facebookPublic.route.ts',
    ...exampleDocs.filter(file => fs.existsSync(path.join(root, file))));
  validate();
  console.info(`Prepared main: removed ${removing.length} files. Review staged changes, build, then commit.`);
}

try {
  for (const arg of args) if (!['--check', '--allow-dirty'].includes(arg)) throw new Error(`Unknown option: ${arg}`);
  if (check) validate(); else prepare();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
