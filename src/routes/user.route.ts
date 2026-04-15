import { Router } from 'express';
import CompanyController from '@surefy/console/http/controllers/company.controller';

const UserRoute = Router();

// All company endpoints - JWT authentication applied at route group level
// Only admins can create/manage companies
UserRoute.post('/', CompanyController.onboard); // Admin creates new company
UserRoute.post('/create', CompanyController.createUser); // Admin creates new user under company
UserRoute.get('/', CompanyController.getAll);
UserRoute.get('/:id', CompanyController.getById);
UserRoute.put('/:id', CompanyController.update);
UserRoute.delete('/:id', CompanyController.delete);
UserRoute.post('/:id/regenerate-keys', CompanyController.regenerateKeys);
UserRoute.get('/stats', CompanyController.getUserStats)
// UserRoute.get('/notifications', CompanyController.getNotifications)

export default UserRoute;





















// UserRoute.get('/stats', CompanyController.getUserStats)

//   getUserStats = tryCatchAsync(async(req:Request,res:Response)=>{
//     const userStats = await CompanyService.getUserStats(req.userId!)
//     return successResponse(req,res, 'User Stats retrieved successfully', userStats)
//   })

//   async getUserStats(userId:any){
//     const userStats = await companyRepository.getUserStats(userId)
//     return userStats
//   }


//   async getUserStats(userId:string){
//     return CompanyModel.getUserStats(userId)
//   }


// async getUserStats(userId: string) {
//   return this.query()
//     .select(
//       this.query()
//         .from('campaigns')
//         .count('*')
//         .where('user_id', userId)
//         .as('campaigns_count'),

//       this.query()
//         .from('contact_lists')
//         .count('*')
//         .where('user_id', userId)
//         .as('contact_lists_count'),

//       this.query()
//         .from('templates')
//         .count('*')
//         .where('company_id', (qb:any) => {
//           qb.select('company_id')
//             .from('users')
//             .where('id', userId)
//             .limit(1);
//         })
//         .as('templates_count')
//     )
//     .first()
//     .then((res: any) => ({
//       ...res,
//       total_count:
//         Number(res.campaigns_count) +
//         Number(res.contact_lists_count) +
//         Number(res.templates_count),
//     }));
// }