import { Router } from 'express';
import teamController from '../app/http/controllers/team.controller';

const teamInviteRoute = Router()

teamInviteRoute.post('/invite',teamController.teamInvite)
teamInviteRoute.post('/setup-password',teamController.setUpPassword)
teamInviteRoute.get('/invites', teamController.userTeamInvites)
teamInviteRoute.delete('/:id/invite')

export default teamInviteRoute