import { Router } from 'express';
import teamController from '../app/http/controllers/team.controller';
import { checkPlanLimit } from '@surefy/middleware/plan.middleware';

const teamInviteRoute = Router();

teamInviteRoute.post('/invite', checkPlanLimit('TeamInvite'), teamController.teamInvite)
teamInviteRoute.post('/setup-password',teamController.setUpPassword)
teamInviteRoute.get('/invites', teamController.userTeamInvites)
teamInviteRoute.delete('/:id/invite', teamController.deleteTeamInvite)
teamInviteRoute.patch('/:id/permissions', teamController.updateMemberPermissions)
teamInviteRoute.get('/my-permissions', teamController.getMyPermissions)


export default teamInviteRoute;
