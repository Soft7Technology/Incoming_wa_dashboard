"use strict";
// import knex, { Knex } from 'knex';
// import knexConfig from '../config/knex.config';
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// const environment = process.env.NODE_ENV || 'development';
// const config = knexConfig[environment];
// const db: Knex = knex(config);
// export default db;
const knex_1 = __importDefault(require("knex"));
const knex_config_1 = __importDefault(require("../config/knex.config"));
const environment = process.env.NODE_ENV || 'development';
const config = knex_config_1.default[environment];
let db;
// ✅ Prevent multiple connections (singleton)
if (!global.db) {
    global.db = (0, knex_1.default)(Object.assign(Object.assign({}, config), { 
        // ✅ Add connection pool
        pool: {
            min: 2,
            max: 5,
            acquireTimeoutMillis: 30000,
            idleTimeoutMillis: 10000
        } }));
}
db = global.db;
// ✅ Close DB properly on PM2 reload
const shutdown = () => __awaiter(void 0, void 0, void 0, function* () {
    try {
        yield db.destroy();
        console.log('DB disconnected');
    }
    catch (err) {
        console.error('Error closing DB:', err);
    }
});
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
exports.default = db;
//# sourceMappingURL=index.js.map