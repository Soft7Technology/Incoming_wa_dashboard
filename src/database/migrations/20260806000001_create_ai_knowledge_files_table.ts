import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("ai_knowledge_files", (table) => {
    table.increments("id").primary();
    table.integer("ai_assistant_id").unsigned().notNullable();
    table.foreign("ai_assistant_id").references("id").inTable("ai_assistants").onDelete("CASCADE");
    table.string("file_name", 255).notNullable();
    table.string("file_type", 50).notNullable();
    table.string("file_path", 1000).notNullable();
    table.text("extracted_text", "longtext").nullable();
    table.timestamps(true, true); // created_at, updated_at
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("ai_knowledge_files");
}
