export type TicketSavePlan<Planning, Specification> = {
  planning?: Planning;
  specification?: Specification;
};

export type TicketSaveCommands<Planning, Specification> = {
  savePlanning(input: Planning): Promise<boolean> | boolean;
  saveSpecification(input: Specification): Promise<boolean> | boolean;
};

export async function saveTicketEdits<Planning, Specification>(
  plan: TicketSavePlan<Planning, Specification>,
  commands: TicketSaveCommands<Planning, Specification>,
): Promise<boolean> {
  if (plan.planning !== undefined && !(await commands.savePlanning(plan.planning))) return false;
  if (plan.specification !== undefined && !(await commands.saveSpecification(plan.specification))) {
    return false;
  }
  return true;
}
