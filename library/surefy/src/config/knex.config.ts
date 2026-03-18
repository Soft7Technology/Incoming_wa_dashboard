import { Knex } from 'knex'
import path from 'node:path'
import dotenv from 'dotenv'

export const basePath = path.resolve(__dirname, '../../../../')

dotenv.config({ path: path.join(basePath, '.env') })

const config: { [key: string]: Knex.Config } = {
  development: {
    client: 'pg',
    debug: false,
    connection: process.env.DATABASE_URL,
    // connection: "postgres://surefydev:Surefy^23dK@13.202.117.242:5432/surefy_consoledb",
    migrations: {
      directory: path.join(basePath, 'src/database/migrations'),
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
      directory: path.join(basePath, 'src/database/migrations'),
    },
    seeds: {
      directory: path.join(basePath, 'src/database/seeds'),
    },
  },
}

export default config
