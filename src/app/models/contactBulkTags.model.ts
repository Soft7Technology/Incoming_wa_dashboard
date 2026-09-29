import { Knex } from 'knex';

const INSERT_BATCH_SIZE = 1000;

class ContactBulkTagsModel {
  lockOwnedContacts(
    trx: Knex.Transaction,
    ownerId: string,
    companyId: string,
    actorId: string,
    contactIds: string[],
  ): PromiseLike<{ id: string }[]> {
    // Lock in a stable order to reduce deadlocks between overlapping batches.
    const query = trx('contacts')
      .where({ user_id: ownerId, company_id: companyId })
      .whereIn('id', contactIds)
      .whereNull('deleted_at')
      .orderBy('id')
      .forUpdate()
      .select('id');

    if (actorId !== ownerId) {
      query.whereRaw('assigned_to @> ARRAY[?]::uuid[]', [actorId]);
    }
    return query;
  }

  lockOwnedTags(
    trx: Knex.Transaction,
    ownerId: string,
    companyId: string,
    tagIds: string[],
  ): PromiseLike<{ id: string }[]> {
    return trx('contact_tags')
      .where({ user_id: ownerId, company_id: companyId })
      .whereIn('id', tagIds)
      .whereNull('deleted_at')
      .orderBy('id')
      .forUpdate()
      .select('id');
  }

  /** Caller must validate and lock the owned contacts and tags in this transaction first. */
  async insertAssignments(trx: Knex.Transaction, contactIds: string[], tagIds: string[]): Promise<number> {
    const relations = contactIds.flatMap((contact_id) => tagIds.map((tag_id) => ({ contact_id, tag_id })));
    const insertedPerTag = new Map<string, number>();
    let addedCount = 0;

    // Bound SQL parameters. RETURNING contains only newly inserted relationships,
    // so retries and existing assignments never inflate the stored contact counts.
    for (let offset = 0; offset < relations.length; offset += INSERT_BATCH_SIZE) {
      const inserted: { tag_id: string }[] = await trx('contact_tag_relations')
        .insert(relations.slice(offset, offset + INSERT_BATCH_SIZE))
        .onConflict(['contact_id', 'tag_id'])
        .ignore()
        .returning('tag_id');

      addedCount += inserted.length;
      for (const row of inserted) {
        insertedPerTag.set(row.tag_id, (insertedPerTag.get(row.tag_id) || 0) + 1);
      }
    }

    for (const tagId of tagIds) {
      const count = insertedPerTag.get(tagId);
      if (!count) continue;
      await trx('contact_tags')
        .where({ id: tagId })
        .update({
          contact_count: trx.raw('COALESCE(contact_count, 0) + ?', [count]),
        });
    }
    return addedCount;
  }
}

export default new ContactBulkTagsModel();
