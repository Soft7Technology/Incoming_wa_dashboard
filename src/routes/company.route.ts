import { Router } from 'express';
import CompanyController from '@surefy/console/http/controllers/company.controller';

const CompanyRoute = Router();

// All company endpoints - JWT authentication applied at route group level
// Only admins can create/manage companies
CompanyRoute.post('/', CompanyController.onboard); // Admin creates new company
CompanyRoute.get('/', CompanyController.getAll);
CompanyRoute.get('/:id', CompanyController.getById);
CompanyRoute.put('/:id', CompanyController.update);
CompanyRoute.delete('/:id', CompanyController.delete);
CompanyRoute.post('/:id/regenerate-keys', CompanyController.regenerateKeys);
CompanyRoute.get('/user/stats', CompanyController.getUserStats)

export default CompanyRoute;





















// CompanyRoute.get('/stats', CompanyController.getUserStats)

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