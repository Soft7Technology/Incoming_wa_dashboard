import db from '../database';
import { Knex } from 'knex';

export class BaseModel {
  protected tableName: string;
  protected db: Knex;

  constructor(tableName: string) {
    this.tableName = tableName;
    this.db = db;
  }

  protected query() {
    return this.db(this.tableName);
  }

  async findById(id: string) {
    // console.log("Id",id)
    return this.query().where({ id }).first();
  }

  async findOne(conditions: any) {
    return this.query().where(conditions).first();
  }

  async findAll(conditions: any = {}) {
    return this.query().where(conditions);
  }

  async create(data: any) {
    // Convert arrays and objects to JSON strings or raw json bindings for JSON columns
    const processedData = { ...data };
    Object.keys(processedData).forEach(key => {
      if (processedData[key] === undefined) {
        delete processedData[key];
      } else if (Array.isArray(processedData[key]) || (typeof processedData[key] === 'object' && processedData[key] !== null && !(processedData[key] instanceof Date))) {
        processedData[key] = this.db.raw('?::json', [JSON.stringify(processedData[key])]);
      } else if (typeof processedData[key] === 'string' && (key === 'file_headers' || key === 'import_options' || key === 'attributes' || key === 'custom_fields')) {
        let jsonStr = processedData[key];
        try {
          JSON.parse(jsonStr);
        } catch {
          jsonStr = JSON.stringify(jsonStr.split(',').map((s: string) => s.trim()));
        }
        processedData[key] = this.db.raw('?::json', [jsonStr]);
      }
    });

    const [result] = await this.query().insert(processedData).returning('*');
    return result;
  }

  async update(id: string | number | any, data: any) {
    // Convert arrays and objects to JSON strings or raw json bindings for JSON columns
    const processedData = { ...data };
    Object.keys(processedData).forEach(key => {
      if (processedData[key] === undefined) {
        delete processedData[key];
      } else if (Array.isArray(processedData[key]) || (typeof processedData[key] === 'object' && processedData[key] !== null && !(processedData[key] instanceof Date))) {
        processedData[key] = this.db.raw('?::json', [JSON.stringify(processedData[key])]);
      } else if (typeof processedData[key] === 'string' && (key === 'file_headers' || key === 'import_options' || key === 'attributes' || key === 'custom_fields')) {
        let jsonStr = processedData[key];
        try {
          JSON.parse(jsonStr);
        } catch {
          jsonStr = JSON.stringify(jsonStr.split(',').map((s: string) => s.trim()));
        }
        processedData[key] = this.db.raw('?::json', [jsonStr]);
      }
    });

    if (Object.keys(processedData).length === 0) {
      return this.findOne({ id });
    }

    const [result] = await this.query().where({ id }).update(processedData).returning('*');
    return result;
  }

  async delete(id: string | number | any) {
    return this.query().where({ id }).del();
  }

  async count(conditions: any = {}) {
    const result = await this.query().where(conditions).count('* as count').first();
    return parseInt(result?.count as string) || 0;
  }
}
