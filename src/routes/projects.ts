import { Router } from 'express';
import { tenantGuard, moduleGuard, mustChangePasswordGuard, permissionGuard } from '../middleware/auth.js';
import { prisma } from '../db.js';
import {
  createProject,
  listProjects as listProjectsController,
  getProject,
  updateProject,
  updateProjectStatus,
  deleteProject,
  createMilestone,
  updateMilestone,
  deleteMilestone,
  addMaterial,
  updateMaterial,
  deleteMaterial,
  removeMaterialItem,
  listAssignments,
  createAssignment,
  deleteAssignment,
  addProjectExpense,
  deleteProjectExpense,
} from '../controllers/projects.controller.js';

const router = Router();
router.use(tenantGuard, mustChangePasswordGuard, moduleGuard('projects'));

/**
 * @openapi
 * /api/v1/projects:
 *   get:
 *     summary: List projects
 *     tags: [Projects]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Paginated project list
 */
router.get('/', permissionGuard('projects', 'canRead'), async (req, res) => {
  const hasCustomerFilter = typeof req.query.customerId === 'string' && req.query.customerId.length > 0;
  const hasSearch = typeof req.query.search === 'string' && req.query.search.length > 0;

  if (!hasCustomerFilter && !hasSearch) {
    return listProjectsController(req, res);
  }

  try {
    const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
    const status = req.query.status ? String(req.query.status) : undefined;
    const customerId = hasCustomerFilter ? String(req.query.customerId) : undefined;
    const search = hasSearch ? String(req.query.search) : undefined;
    const skip = (page - 1) * limit;

    const where: any = { tenantId: req.tenantId! };
    if (status) where.status = status as any;
    if (customerId) where.customerId = customerId;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { customer: { name: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [projects, total] = await Promise.all([
      prisma.project.findMany({
        where,
        include: {
          customer: { select: { id: true, name: true } },
          milestones: true,
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.project.count({ where }),
    ]);

    return res.json({
      success: true,
      message: 'Projects retrieved successfully',
      data: projects,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('Error listing projects:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve projects',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * @openapi
 * /api/v1/projects:
 *   post:
 *     summary: Create a project
 *     tags: [Projects]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               customerId:
 *                 type: string
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               status:
 *                 type: string
 *               progress:
 *                 type: integer
 *               budget:
 *                 type: number
 *               technician:
 *                 type: string
 *               startDate:
 *                 type: string
 *                 format: date-time
 *               dueDate:
 *                 type: string
 *                 format: date-time
 *               milestones:
 *                 type: array
 *                 items:
 *                   type: object
 *               materials:
 *                 type: array
 *                 items:
 *                   type: object
 *     responses:
 *       201:
 *         description: Project created
 */
router.post('/', permissionGuard('projects', 'canCreate'), createProject);

/**
 * @openapi
 * /api/v1/projects/{id}:
 *   get:
 *     summary: Get a project
 *     tags: [Projects]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Project details
 */
router.get('/:id', permissionGuard('projects', 'canRead'), getProject);

/**
 * @openapi
 * /api/v1/projects/{id}:
 *   patch:
 *     summary: Update a project
 *     tags: [Projects]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Project updated
 */
router.patch('/:id', permissionGuard('projects', 'canUpdate'), updateProject);

/**
 * @openapi
 * /api/v1/projects/{id}/status:
 *   patch:
 *     summary: Update project status
 *     tags: [Projects]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status:
 *                 type: string
 *     responses:
 *       200:
 *         description: Project status updated
 */
router.patch('/:id/status', permissionGuard('projects', 'canUpdate'), updateProjectStatus);

/**
 * @openapi
 * /api/v1/projects/{id}:
 *   delete:
 *     summary: Delete a project
 *     tags: [Projects]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       204:
 *         description: Project deleted
 */
router.delete('/:id', permissionGuard('projects', 'canDelete'), deleteProject);

/**
 * @openapi
 * /api/v1/projects/{id}/milestones:
 *   post:
 *     summary: Add a project milestone
 *     tags: [Projects]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:
 *                 type: string
 *     responses:
 *       201:
 *         description: Milestone created
 */
router.post('/:id/milestones', permissionGuard('projects', 'canCreate'), createMilestone);

/**
 * @openapi
 * /api/v1/projects/{id}/milestones/{milestoneId}:
 *   patch:
 *     summary: Update a milestone
 *     tags: [Projects]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: milestoneId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Milestone updated
 */
router.patch('/:id/milestones/:milestoneId', permissionGuard('projects', 'canUpdate'), updateMilestone);

/**
 * @openapi
 * /api/v1/projects/{id}/milestones/{milestoneId}:
 *   delete:
 *     summary: Delete a milestone
 *     tags: [Projects]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: milestoneId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       204:
 *         description: Milestone deleted
 */
router.delete('/:id/milestones/:milestoneId', permissionGuard('projects', 'canDelete'), deleteMilestone);

/**
 * @openapi
 * /api/v1/projects/{id}/materials:
 *   post:
 *     summary: Add project material
 *     tags: [Projects]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, quantity, unitCost]
 *     responses:
 *       201:
 *         description: Material added
 */
router.post('/:id/materials', permissionGuard('projects', 'canCreate'), addMaterial);

/**
 * @openapi
 * /api/v1/projects/{id}/materials/{materialId}:
 *   patch:
 *     summary: Update project material
 *     tags: [Projects]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: materialId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Material updated
 */
router.patch('/:id/materials/:materialId', permissionGuard('projects', 'canUpdate'), updateMaterial);

/**
 * @openapi
 * /api/v1/projects/{id}/materials/{materialId}:
 *   delete:
 *     summary: Delete project material
 *     tags: [Projects]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: materialId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       204:
 *         description: Material deleted
 */
router.delete('/:id/materials/:materialId', permissionGuard('projects', 'canDelete'), deleteMaterial);

/**
 * @openapi
 * /api/v1/projects/{id}/materials/{materialId}/items/{itemId}:
 *   delete:
 *     summary: Remove a single serialised item from a project material
 *     tags: [Projects]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: materialId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: itemId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: reason
 *         schema:
 *           type: string
 *           enum: [faulty]
 *         description: Pass reason=faulty to mark the item as FAULTY instead of AVAILABLE
 *     responses:
 *       200:
 *         description: Item removed, material updated with remaining assigned items
 *       404:
 *         description: Material or item not found
 */
router.delete('/:id/materials/:materialId/items/:itemId', permissionGuard('projects', 'canDelete'), removeMaterialItem);

// ── Project Assignment Routes ────────────────────────────────────────────────
router.get('/:id/assignments', permissionGuard('projects', 'canRead'), listAssignments);
router.post('/:id/assignments', permissionGuard('projects', 'canUpdate'), createAssignment);
router.delete('/:id/assignments/:assignmentId', permissionGuard('projects', 'canUpdate'), deleteAssignment);

// ── Project Expense (Additional Costs) Routes ────────────────────────────────
router.post('/:id/expenses', permissionGuard('projects', 'canCreate'), addProjectExpense);
router.delete('/:id/expenses/:txId', permissionGuard('projects', 'canDelete'), deleteProjectExpense);

export default router;
