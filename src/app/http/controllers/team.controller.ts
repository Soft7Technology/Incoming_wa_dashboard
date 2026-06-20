import { Request, Response } from 'express';
import { successResponse,errorResponse, tryCatchAsync } from '@surefy/utils/Controller';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import { AuthRequest } from '@surefy/middleware/auth.middleware';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import sendEmail from '@surefy/console/utils';
import teamService from '@surefy/console/services/team.service';
import userModel from '../../models/user.model';
import userTeamModel from '../../models/team.model';
import db from '@surefy/database';

class teamController{
    /**
     * POST /v1/team/invite
     */
    teamInvite = tryCatchAsync(async (req: AuthRequest, res: Response) => {
        try {
            const { name, email, phone_number, role, permission } = req.body
            if (!email || !phone_number || !role) {
                throw new HTTP400Error({ message: 'Email, phone number, and role are required' });
            }
            // permission is a flat array of nav keys e.g. ["dashboard", "contact"]
            const permissionArray: string[] = Array.isArray(permission) ? permission : []
            const invite_sent_by  = req.userId!
            const company_id = req.companyId!

            const existingEmail = await userModel.findByEmailPhone(email,phone_number)
            console.log("EXISTING",existingEmail)
            if(existingEmail){
                return res.status(400).json({
                    success:false,
                    message:"Cannot send team invite User Email already exists"
                })
            }

            const inviteTeam = await teamService.inviteTeam({ name, invite_sent_by, company_id, email, phone_number, role, permission: permissionArray })
            successResponse(req, res, `Invite send ${email} successfully`, inviteTeam)
        } catch (error: any) {
            console.error('Create Ticket Error:', error);

            return res.status(500).json({
                success: false,
                message: error?.message || 'Internal Server Error',
            });
        }
    })

    /**
     * POST /v1/team/setup-password
     */
    setUpPassword =tryCatchAsync(async(req:AuthRequest,res:Response)=>{
        try{
            const {token,password} = req.body
            const setUpTeamMemberPassword = await teamService.setUpTeammatePassword(token,password)
            successResponse(req,res,"Password set successfully",setUpTeamMemberPassword,HttpStatusCode.OK)
        }catch(error:any){
            console.error('Create Ticket Error:', error);
            return res.status(500).json({
                success: false,
                message: error?.message || 'Internal Server Error',
            });
        }
    })

    /**
     * GET /v1/team/invites
     */
    userTeamInvites = tryCatchAsync(async(req: JWTAuthRequest, res: Response)=>{
        // Members see the invites sent by the owner (their inviter)
        const effectiveUserId = req.ownerId ?? req.userId!;
        const teamInvites = await teamService.userInvites(effectiveUserId)
        successResponse(req,res,"All User Invites",teamInvites)
    })

    /**
     * DELETE /v1/team/:id/invite
     */
    deleteTeamInvite = tryCatchAsync(async(req:AuthRequest,res:Response)=>{
        const{id}=req.params
        const deleteInvite = await teamService.deleteInvite(id)
        successResponse(req,res,"Delete team invite successfully",deleteInvite,HttpStatusCode.ACCEPTED)
    })

    /**
     * PATCH /v1/team/:id/permissions
     * Add nav permissions to an accepted team member.
     * :id is the user.id of the team member.
     * Body: { add: string[] }  — array of nav keys to add, e.g. ["inbox"]
     */
    updateMemberPermissions = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
        const { id } = req.params;
        const { add = [] }: { add: string[] } = req.body;

        // Find the user to get their email
        const user = await userModel.findById(id);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // Find the user_team row for this member (invited by the current user or by owner)
        const effectiveUserId = req.ownerId ?? req.userId!;
        const teamRow = await db('user_team')
            .where('email', user.email)
            .where('invite_status', 'accepted')
            .first();

        if (!teamRow) {
            return res.status(404).json({ success: false, message: 'Team member not found' });
        }

        // Merge new permissions into existing nav array
        const existing: any = teamRow.permission ?? {};
        const existingNav: string[] = Array.isArray(existing?.nav)
            ? existing.nav
            : (Array.isArray(existing) ? existing : []);

        const { replace }: { replace?: string[] } = req.body;

        // If `replace` is provided, use it as the full new nav list; otherwise append
        const mergedNav = replace !== undefined
            ? replace.map((k: string) => k.toLowerCase())
            : [...new Set([...existingNav, ...add.map((k: string) => k.toLowerCase())])];

        const updatedPermission = Array.isArray(existing)
            ? mergedNav  // legacy flat array
            : { ...existing, nav: mergedNav };

        await db('user_team')
            .where('id', teamRow.id)
            .update({ permission: JSON.stringify(updatedPermission) });

        return successResponse(req, res, 'Permissions updated successfully', { permission: updatedPermission });
    })
}

export default new teamController()
