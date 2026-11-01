// Oracle graders: how a task's declared oracle decides whether an attempt resolved it.
//
// `resolved` used to be computed by the only grader in the package, so a task could not
// state what would settle it and a second kind of task had nowhere to land (review 0003
// Q78). A grader is registered against an oracle type from `task-schema.mjs`; the runner
// asks the task's oracle, and an oracle type with no grader is refused by name rather
// than silently graded as if it were a test patch.
const ORACLE_GRADERS = new Map();

/**
 * Register the grader for one oracle type.
 *
 * @param {string} type the oracle type a task declares
 * @param {(workDir: string, task: object, context: object) => Promise<object>} grade
 */
export function registerOracle(type, grade) {
  ORACLE_GRADERS.set(String(type), grade);
}

/** The oracle types this process can grade, sorted. */
function oracleTypes() {
  return [...ORACLE_GRADERS.keys()].sort();
}

/**
 * Grade a finished workspace through the task's own oracle.
 *
 * @param {string} workDir
 * @param {object} task a normalised v2 task
 * @param {object} context grader inputs (vault root, initial head, timeout)
 * @returns {Promise<object>}
 */
export async function gradeWithOracle(workDir, task, context) {
  const type = String(task?.oracle?.type ?? 'tests');
  const grade = ORACLE_GRADERS.get(type);
  if (!grade) {
    throw new Error(
      `no grader for oracle type "${type}"; this package grades: ${oracleTypes().join(', ') || '(none)'}`,
    );
  }
  return grade(workDir, task, context);
}
