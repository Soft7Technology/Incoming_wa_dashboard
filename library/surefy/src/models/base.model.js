"use strict";
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
exports.BaseModel = void 0;
const database_1 = __importDefault(require("../database"));
class BaseModel {
    constructor(tableName) {
        this.tableName = tableName;
        this.db = database_1.default;
    }
    query() {
        return this.db(this.tableName);
    }
    findById(id) {
        return __awaiter(this, void 0, void 0, function* () {
            // console.log("Id",id)
            return this.query().where({ id }).first();
        });
    }
    findOne(conditions) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.query().where(conditions).first();
        });
    }
    findAll() {
        return __awaiter(this, arguments, void 0, function* (conditions = {}) {
            return this.query().where(conditions);
        });
    }
    create(data) {
        return __awaiter(this, void 0, void 0, function* () {
            // Convert arrays and objects to JSON strings for JSONB columns
            const processedData = Object.assign({}, data);
            Object.keys(processedData).forEach(key => {
                if (Array.isArray(processedData[key]) || (typeof processedData[key] === 'object' && processedData[key] !== null && !(processedData[key] instanceof Date))) {
                    processedData[key] = JSON.stringify(processedData[key]);
                }
            });
            const [result] = yield this.query().insert(processedData).returning('*');
            return result;
        });
    }
    update(id, data) {
        return __awaiter(this, void 0, void 0, function* () {
            // Convert arrays and objects to JSON strings for JSONB columns
            const processedData = Object.assign({}, data);
            Object.keys(processedData).forEach(key => {
                if (Array.isArray(processedData[key]) || (typeof processedData[key] === 'object' && processedData[key] !== null && !(processedData[key] instanceof Date))) {
                    processedData[key] = JSON.stringify(processedData[key]);
                }
            });
            const [result] = yield this.query().where({ id }).update(processedData).returning('*');
            return result;
        });
    }
    delete(id) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.query().where({ id }).del();
        });
    }
    count() {
        return __awaiter(this, arguments, void 0, function* (conditions = {}) {
            const result = yield this.query().where(conditions).count('* as count').first();
            return parseInt(result === null || result === void 0 ? void 0 : result.count) || 0;
        });
    }
}
exports.BaseModel = BaseModel;
//# sourceMappingURL=base.model.js.map