import { BaseModel } from '@surefy/models/base.model';
import db from '@surefy/database';

class permissionModel {
    async assignedTeam(permission: any, assigned_to: any) {
        console.log("Permission", permission, assigned_to)
        const tableMap: Record<string, string> = {
            Contact: 'contacts',
            Campaign: 'campaigns',
            ChatBot: 'chat_bot',
        }

        const tableName = tableMap[permission]

        if (!tableName) {
            throw new Error(`Invalid Permission ${permission}`)
        }

        const tableData = await db(tableName).select('*')
        console.log("Table", tableData)
        for (const data of tableData) {
            const existingAssignedTo = data.assigned_to || []
            // const updatedAssignedTo = [
            //     ...new Set([...existingAssignedTo, assigned_to])
            // ]

            await db(tableName)
                .where('id', data.id)
                .update({
                    assigned_to: db.raw(
                        `ARRAY(
                SELECT DISTINCT unnest(
                    array_append(
                        COALESCE(assigned_to, '{}'),
                        ?::uuid
                    )
                )
            )`,
                        [assigned_to]
                    )
                });
        }
        return `${tableName} assigned successfully `
    }
}


export default new permissionModel()