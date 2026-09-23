import db from '@surefy/database';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import planUsageService, { syncTeamSeats } from './planUsage.service';
import userTeamModel from '@surefy/console/app/models/team.model'
import sendEmail from '@surefy/console/utils';
import crypto from "crypto";
import { generateInviteTemplate } from '@surefy/console/utils';
import bcrypt from "bcrypt";
import userModel from '../models/user.model';
import { Model } from 'firebase-admin/lib/machine-learning/machine-learning';
import permissionModel from '../models/permission.model';
import { bulkUpdateTableExecutionQueue } from '@surefy/console/queues/bulkTableUpdate.queue';
import companyDomainModel from '../models/companyDomain.model';

class teamService{
    async inviteTeam(data: any) {
        const { name, email, role, invite_sent_by, domain_name } = data;
        const token = crypto.randomBytes(32).toString('hex');
        const inviteUrl = `https://${domain_name}/team/setup-password?token=${token}`;
        const html = generateInviteTemplate({ name, email, role, inviteUrl });
        // Reserve the seat and persist the invitation before contacting the mail provider.
        const invite = await planUsageService.run(invite_sent_by, 'TeamInvite', async (trx, plan) => {
            const existing = await trx('user_team').where({ email, invite_sent_by }).first();
            if (existing) throw new HTTP400Error({ message: 'User already invited' });
            return userTeamModel.create({ ...data, assigned_plan: plan.id,
                role: role.toLowerCase(), invite_token: token, invite_status: 'sent' }, trx);
        });
        try {
            const sent = await sendEmail(email, "You're Invited to Join Soft7", '', html);
            if (!sent) throw new Error('Failed to send invite email');
        } catch (error) {
            // Refund only a still-pending invitation; an accepted member keeps its seat.
            await db.transaction(async trx => {
                await trx('users').where({ id: invite_sent_by }).forUpdate().first();
                await trx('user_team').where({ id: invite.id, invite_sent_by, invite_status: 'sent' }).delete();
                await syncTeamSeats(trx, invite_sent_by);
            });
            throw error;
        }
        return { success: true, message: 'Team invite sent successfully', data: invite };
    }

    async setUpTeammatePassword(token: string, password: string, domain_name: string) {
        const found = await userTeamModel.findOne({ invite_token: token });
        if (!found) throw new HTTP400Error({ message: 'Invalid invite token' });
        const domain = await companyDomainModel.findByDomain(domain_name);
        if (!domain || domain.company_id !== found.company_id) {
            throw new HTTP400Error({ message: 'Invitation does not belong to this company domain' });
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        return db.transaction(async trx => {
            await trx('users').where({ id: found.invite_sent_by }).forUpdate().first();
            const invite = await trx('user_team').where({ id: found.id, invite_token: token }).forUpdate().first();
            if (!invite || invite.invite_status !== 'sent') {
                throw new HTTP400Error({ message: 'Invitation is no longer pending' });
            }
            const existing = await trx('users').where({ email: invite.email }).first();
            if (existing) throw new HTTP400Error({ message: 'User email already exists' });
            const createdUser = await userModel.create({
                name: invite.name, company_id: invite.company_id, domain_name: domain.domain_name,
                email: invite.email, phone: invite.phone_number, role: invite.role,
                permissions: Array.isArray(invite.permission) ? invite.permission : (invite.permission?.nav ?? []),
                password: hashedPassword, status: 'active',
            }, trx);
            await trx('user_team').where({ id: invite.id }).update({ invite_status: 'accepted', user_id: createdUser.id });
            // Pending and accepted both occupy one seat: no usage increment here.
            return { success: true, message: 'Password setup successful', data: createdUser };
        });
    }

    async userInvites(userId: string) {
        const invites = await userTeamModel.findAll({ invite_sent_by: userId })
        // Normalize each record: lowercase role, ensure name is present
        // Also fetch the real user's status so UI can show Suspend/Restore correctly
        const db = userTeamModel['db'] as any;
        return Promise.all(invites.map(async (invite: any) => {
            let user_status = 'unknown';
            try {
                const user = await db('users').where('email', invite.email).select('status').first();
                user_status = user?.status ?? 'unknown';
            } catch { /* ignore */ }
            return {
                ...invite,
                name: invite.name ?? null,
                role: invite.role ? invite.role.toLowerCase() : invite.role,
                user_status,
                permission: invite.permission ?? null,
            };
        }));
    }

    async deleteInvite(inviteId: string, ownerId: string) {
        return db.transaction(async trx => {
            await trx('users').where({ id: ownerId }).forUpdate().first();
            const invite = await trx('user_team').where({ id: inviteId, invite_sent_by: ownerId }).forUpdate().first();
            if (!invite) throw new HTTP400Error({ message: 'Team invitation not found in this account' });
            if (invite.invite_status === 'accepted' && invite.user_id && invite.user_id !== ownerId) {
                await trx('users').where({ id: invite.user_id, company_id: invite.company_id }).delete();
            }
            const deleted = await trx('user_team').where({ id: inviteId }).delete();
            await syncTeamSeats(trx, ownerId);
            return deleted;
        });
    }

}


export default new teamService();
