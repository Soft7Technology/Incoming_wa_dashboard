"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.basePath = void 0;
const node_path_1 = __importDefault(require("node:path"));
const dotenv_1 = __importDefault(require("dotenv"));
exports.basePath = node_path_1.default.resolve(__dirname, '../../../../');
dotenv_1.default.config({ path: node_path_1.default.join(exports.basePath, '.env') });
const config = {
    development: {
        client: 'pg',
        debug: false,
        connection: process.env.DATABASE_URL,
        // connection: "postgres://surefydev:Surefy^23dK@13.202.117.242:5432/surefy_consoledb",
        migrations: {
            directory: node_path_1.default.join(exports.basePath, 'src/database/migrations'),
        },
        seeds: {
            directory: node_path_1.default.join(exports.basePath, 'src/database/seeds'),
        },
    },
    production: {
        client: 'pg',
        connection: process.env.DATABASE_URL,
        // connection: "postgres://surefydev:Surefy^23dK@13.202.117.242:5432/surefy_consoledb",
        migrations: {
            directory: node_path_1.default.join(exports.basePath, 'src/database/migrations'),
        },
        seeds: {
            directory: node_path_1.default.join(exports.basePath, 'src/database/seeds'),
        },
    },
};
exports.default = config;
//# sourceMappingURL=knex.config.js.map