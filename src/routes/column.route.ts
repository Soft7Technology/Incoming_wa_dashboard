import { Router } from 'express';
import ColumnController from '@surefy/console/http/controllers/column.controller';

const ColumnRoute = Router();

ColumnRoute.get('/', ColumnController.getColumns);
ColumnRoute.post('/', ColumnController.createColumn);
ColumnRoute.get('/:id', ColumnController.getColumnById);
ColumnRoute.put('/:id', ColumnController.updateColumn);
ColumnRoute.delete('/:id', ColumnController.deleteColumn);

export default ColumnRoute;
