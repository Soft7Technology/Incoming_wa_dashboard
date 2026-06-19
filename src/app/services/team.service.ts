import userTeamModel from '@surefy/console/app/models/team.model'
import sendEmail from '@surefy/console/utils';
import crypto from "crypto";
import { generateInviteTemplate } from '@surefy/console/utils';
import bcrypt from "bcrypt";
import userModel from '../models/user.model';
import { Model } from 'firebase-admin/lib/machine-learning/machine-learning';
import permissionModel from '../models/permission.model';
import { bulkUpdateTableExecutionQueue } from '@surefy/console/queues/bulkTableUpdate.queue';

class teamService{
    async inviteTeam(data: any) {
        try {
            const { name, email, role, invite_sent_by,user_id, company_id, } = data

            const existingInvite = await userTeamModel.findInvite(email,invite_sent_by)
            console.log("Existing Value",existingInvite)

            if(existingInvite){
                return {
                    success:false,
                    message:"User already invited"
                }
            }

            //Generate secure token
            const token = crypto.randomBytes(32).toString("hex");

            //Frontend setup password URL
            const inviteUrl = `https://app.soft7.in/team/setup-password?token=${token}`;

            const html = generateInviteTemplate({
                    name,
                    email,
                    role,
                    inviteUrl
            })

            //Send email first
            const emailResponse = await sendEmail(
                email,
                "You're Invited to Join Soft7",
                "",
                html
            )

            console.log("Email Response",emailResponse)


            //Optional check based on your mail provider
            if(!emailResponse){
                return{
                    success:false,
                    message:"Failed to send Invite email"
                }
            }

            //Store invite only after successful email
            const createInvite = await userTeamModel.create({
                ...data,
                role: role.toLowerCase(),
                invite_token: token,
                invite_status: "sent",
            })

            return{
                sucess:true,
                message:"Team Invite send sucessfully",
                data:createInvite
            }
        } catch (error: any) {
            console.error("Invite Team Error:", error);

            return {
                success: false,
                error: error.message || 'Something went wrong',
            };
        }
    }

    async setUpTeammatePassword(token: string, password: string) {
        try {
            // 1. Find invite by tokeb
            const existingInvite = await userTeamModel.findOne({ invite_token: token })

            //2. Check invite exists
            if (!existingInvite) {
                return {
                    success: false,
                    message: "Invalid invite token"
                }
            }

            // 3.check already accepted
            if (existingInvite.invite_status === 'accepted') {
                
                return {
                    success: false,
                    message: 'Invite already used'
                }
            }

            //4. Check if user already exists
            const existingUser = await userTeamModel.findOne({ email: existingInvite.email })

            if (!existingUser) {
                return {
                    success: false,
                    message: "User not exists"
                }
            }

            //5. Hash Password
            const hashedPassword = await bcrypt.hash(password, 10)

            //6. Create user account
            const createdUser = await userModel.create({
                name:existingInvite.name,
                email: existingInvite.email,
                phone: existingInvite.phone_number,
                role: existingInvite.role,
                permission: existingInvite.permission,
                password: hashedPassword,
                status: "active"
            })

            await userTeamModel.update(existingInvite.id, { invite_status: "accepted" })
            // for(const permission of createdUser.permission){
            //     await bulkUpdateTableExecutionQueue.add(
            //         `bulkTableUpdate - ${permission}`,
            //         {
            //             permission:permission,
            //             assigned_to:createdUser.id
            //         },
            //         {
            //           jobId: createdUser.id,
            //           delay: 3000, // 3-second delay so the DB write fully commits first
            //         }
            //     )
            // }

            // Add user_id into assigned_to array
            // Check permission[] and pass into the permissionModel Update 
            return {
                success: true,
                message: "Password setup successful",
                data: createdUser
            }

        } catch (error: any) {
            console.error(
                "Setup Password Error:",
                error
            );

            return {
                success: false,
                message:
                    error.message ||
                    "Something went wrong"
            };
        }
    }

    async userInvites(userId: string) {
        const invites = await userTeamModel.findAll({ invite_sent_by: userId })
        // Normalize each record: lowercase role, ensure name is present
        return invites.map((invite: any) => ({
            ...invite,
            name: invite.name ?? null,
            role: invite.role ? invite.role.toLowerCase() : invite.role,
        }))
    }

    async deleteInvite(inviteId:string){
        return await userTeamModel.delete(inviteId)
    }
}


export default new teamService();