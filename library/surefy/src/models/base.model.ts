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

  async findById(id: string | number) {
    return this.query().where({ id }).first();
  }

  async findOne(conditions: any) {
    return this.query().where(conditions).first();
  }

  async findAll(conditions: any = {}) {
    return this.query().where(conditions);
  }

  async create(data: any) {
    // Convert arrays and objects to JSON strings for JSONB columns
    console.log("Creating record with data:", data); // Debug log 
    const processedData = { ...data };
    Object.keys(processedData).forEach(key => {
      if (Array.isArray(processedData[key]) || (typeof processedData[key] === 'object' && processedData[key] !== null && !(processedData[key] instanceof Date))) {
        processedData[key] = JSON.stringify(processedData[key]);
      }
    });

    const [result] = await this.query().insert(processedData).returning('*');
    return result;
  }

  async update(id: string | number, data: any) {
    // Convert arrays and objects to JSON strings for JSONB columns
    const processedData = { ...data };
    Object.keys(processedData).forEach(key => {
      if (Array.isArray(processedData[key]) || (typeof processedData[key] === 'object' && processedData[key] !== null && !(processedData[key] instanceof Date))) {
        processedData[key] = JSON.stringify(processedData[key]);
      }
    });

    const [result] = await this.query().where({ id }).update(processedData).returning('*');
    return result;
  }

  async delete(id: string | number) {
    console.log("Deleting record with id:", id); // Debug log
    return this.query().where({ id }).del();
  }

  async count(conditions: any = {}) {
    const result = await this.query().where(conditions).count('* as count').first();
    return parseInt(result?.count as string) || 0;
  }
}
