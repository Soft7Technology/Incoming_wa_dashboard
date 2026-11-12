import { Knex } from 'knex'
import path from 'node:path'
import dotenv from 'dotenv'
import fs from 'node:fs/promises'

export const basePath = path.resolve(__dirname, '../../../../')

// Compiled migrations live under dist, but deployment configuration stays
// beside package.json in the project root.
const envRoot = path.basename(basePath) === 'dist' ? path.dirname(basePath) : basePath
dotenv.config({ path: path.join(envRoot, '.env') })

// Keep the TypeScript names already stored in knex_migrations when running
// compiled JavaScript in Kubernetes, so deployment never replays migrations.
const migrationDirectory = path.join(basePath, 'src/database/migrations')
const compiled = path.basename(basePath) === 'dist'
const migrationSource: Knex.MigrationSource<string> = {
  async getMigrations() {
    return (await fs.readdir(migrationDirectory))
      .filter(file => compiled ? file.endsWith('.js') : file.endsWith('.ts') && !file.endsWith('.d.ts'))
      .sort()
  },
  getMigrationName(file) { return compiled ? file.replace(/\.js$/, '.ts') : file },
  async getMigration(file) { return require(path.join(migrationDirectory, file)) },
}

const config: { [key: string]: Knex.Config } = {
  development: {
    client: 'pg',
    debug: false,
    connection: process.env.DATABASE_URL,
    // connection: "postgres://surefydev:Surefy^23dK@13.202.117.242:5432/surefy_consoledb",
    migrations: {
      ...(compiled ? { migrationSource } : { directory: migrationDirectory }),
    },
    seeds: {
      directory: path.join(basePath, 'src/database/seeds'),
    },
  },
  production: {
    client: 'pg',
    connection: process.env.DATABASE_URL,
    // connection: "postgres://surefydev:Surefy^23dK@13.202.117.242:5432/surefy_consoledb",
    migrations: {
      ...(compiled ? { migrationSource } : { directory: migrationDirectory }),
    },
    seeds: {
      directory: path.join(basePath, 'src/database/seeds'),
    },
  },
}

export default config
