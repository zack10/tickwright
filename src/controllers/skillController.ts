import { Request, Response } from "express";
import prisma from "../db";
import { AppError } from "../errors/AppError";
import { asyncHandler } from "../middleware/asyncHandler";
import { redactAgent } from "../utils/agentConfig";

export const createSkill = asyncHandler(async (req: Request, res: Response) => {
  const { name, description, logic } = req.body;
  const skill = await prisma.skill.create({
    data: { name, description, logic },
  });
  res.status(201).json(skill);
});

export const getSkills = asyncHandler(async (_req: Request, res: Response) => {
  const skills = await prisma.skill.findMany();
  res.status(200).json(skills);
});

export const getSkillById = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const skill = await prisma.skill.findUnique({ where: { id } });
    if (!skill) {
      throw AppError.notFound("Skill not found");
    }
    res.status(200).json(skill);
  },
);

export const updateSkill = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, description, logic } = req.body;
  const skill = await prisma.skill.update({
    where: { id },
    data: { name, description, logic },
  });
  res.status(200).json(skill);
});

export const deleteSkill = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  await prisma.skill.delete({ where: { id } });
  res.status(204).send();
});

export const assignSkillToAgent = asyncHandler(
  async (req: Request, res: Response) => {
    const { agentId, skillId } = req.body;
    const agent = await prisma.agent.update({
      where: { id: agentId },
      data: {
        skills: { connect: { id: skillId } },
      },
      include: { skills: true },
    });
    res.status(200).json(redactAgent(agent));
  },
);
