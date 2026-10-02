I am playing around with the idea of creating an engine that executes these tasks, such as those you identified in vadz, and making the detail itself markdown.

So:

1. Choose a task and subtasks that are fairly meaty from vadz
2. In concert with looking at the eque2-code workflows that generated them, identify the various components of the task / sub-tasks, such as the task itself, and the verification requirement.
3. Produce an aspirational markdown format to represent them: perhaps one file has the task, another the verification of that task? Perhaps they are in the same file, perhaps they are in separate linked files? Perhaps their parent folder has a `.task` component of the foldername to indicate a task and impose an expected structure? Come up with half a dozen representations, and write them to the this repo in a folder in the root

The idea is that there will be a typescript engine that drives the execution of these tasks. We will not maintain state in these files: they are fixed, state is a separate consideration.
