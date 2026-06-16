import { Request, Response } from 'express';
import { successResponse,errorResponse, tryCatchAsync } from '@surefy/utils/Controller';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import { AuthRequest } from '@surefy/middleware/auth.middleware';
import sendEmail from '@surefy/console/utils';
import teamService from '@surefy/console/services/team.service';
import userModel from '../../models/user.model';

class teamController{
    /**
     * POST /v1/team/invite
     */
    teamInvite = tryCatchAsync(async (req: AuthRequest, res: Response) => {
        try {
            const { name, email, phone_number, role, permission } = req.body
            if (!email || !phone_number || !role || !permission) {
                throw new HTTP400Error({ message: 'Phone number ID, recipient, and message type are required' });
            }
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

            const inviteTeam = await teamService.inviteTeam({ name, invite_sent_by, company_id, email, phone_number, role, permission })
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
    userTeamInvites = tryCatchAsync(async(req:AuthRequest,res:Response)=>{
        const teamInvites = await teamService.userInvites(req.userId!)
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
}

export default new teamController()