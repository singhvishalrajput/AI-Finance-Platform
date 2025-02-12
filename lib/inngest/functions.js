import { sendEmail } from "@/actions/send-email";
import { db } from "../prisma";
import { inngest } from "./client";
import EmailTemplate from "@/emails/template";

export const checkBudgetAlert = inngest.createFunction(
  { name: "Check Budget Alert" },
  { cron: "0 */6 * * *" },
  async ({ step }) => {
    const budgets = await step.run("fetch-budget", async () => {
      return await db.budget.findMany({
        include: {
          user:{
            include:{
              accounts: {
                where: {
                  isDefault: true
                },
              },
            },
          },
        },
      });
    });


    for (const budget of budgets){
      const defaultAccount = budget.user.accounts[0];
      if(!defaultAccount) continue; // skip if no default account

      await step.run(`check-budget-${budget.id}`, async () =>{

        const currentDate = new Date();
            const startOfMonth = new Date(
                currentDate.getFullYear(),
                currentDate.getMonth(),
                1
            );
            const endOfMonth = new Date(
                currentDate.getFullYear(),
                currentDate.getMonth() + 1,
                0
            )

        const expenses = await db.transaction.aggregate({
          where: {
            userId: budget.userId,
            accountId: defaultAccount.id,
            type: "EXPENSE",
            date:{
              gte: startOfMonth,
              lte: endOfMonth,
            },
          },
          _sum:{
            amount: true
          },
        });

        const totalExpenses = expenses._sum.amount?.toNumber() || 0;
        const budgetAmount = budget.amount || 1;
        const percentageUsed  = (totalExpenses / budgetAmount) * 100;

        if(percentageUsed >= 80 && (!budget.lastAlertSent || isNewMonth(new Date(budget.lastAlertSent), new Date())))
        {
          // Send Email

          console.log(budget.user.email)

          await sendEmail({
            to: budget.user.email,
            subject: `Budget Alert for ${defaultAccount.name}`,
            react: EmailTemplate({
              userName: budget.user.name,
              type: "budget-alert",
              data:{
                percentageUsed,
                budgetAmount: parseInt(budgetAmount).toFixed(1),
                totalExpenses: parseInt(totalExpenses).toFixed(1),
                accountName: defaultAccount.name,
              }
            })
          })

          // Update lastAlertSent
          await db.budget.update({
            where: { id: budget.id },
            data: { lastAlertSent: new Date() },
          });
        }
      });
    }
  },
);

function isNewMonth(lastAlertDate, currentDate){
  return (
    lastAlertDate.getMonth() !== currentDate.getMonth() ||
    lastAlertDate.getFullYear() !== currentDate.getFullYear()
  );
}

export const triggerRecurringTransactions = inngest.createFunction({
  id: "trigger-recurring-transactions",
  name: "Trigger Recurring Transactions"
},{cron: "0 0 * * *"},
 async ({step}) => {
  // 1. Fetch all due recurring transactions
  const recurringTransactions = await step.run(
    "fetch-recurring-transactions",
    async () => {
      return await db.transaction.findMany({
        where: {
          isRecurring: true,
          status: "COMPLETED",
          OR: [
            { lastProcessed: null},  // Never processed
            { nextRecurringDate: {lte: new Date()}}, // Due date passed
          ],
        },
      });
    }
  )

  // 2. Create events for each transaction
   if (recurringTransactions.length > 0) {
      const events = recurringTransactions.map((transaction) => (
        {
          name: "transaction.recurring.process",
          data: { transactionId: transaction.id, userId: transaction.userId},

        }
      ));

      // 3. Send events to be processed
      await inngest.send(events);
   }

   return { triggered: recurringTransactions.length };
 }
);

export const processRecurringTransaction = inngest.createFunction(
  {
  id: "process-recurring-transaction",
  name: "Process Recurring Transaction",
  throttle: {
    limit: 10, // Only process 10 transactions
    period: "1m", // per minute
    key: "event.data.userId", //per user
  },
  },
  {event: "transaction.recurring.process"},
  async ({ event, step }) => {
    // Validate event data
    if (!event?.data?.transactionId || !event?.data?.userId){
      console.error("Invalid event data:", event);
      return { error: "Missing required event data"};
    }

    await step.run("process-transaction", async()=>{
      const transaction = await db.transaction.findUnique({
        where: {
          id: event.data.transactionId,
          userId: event.data.userId
        },
        include: {
          account: true,
        }
      });
      
      if (!transaction || !isTransactionDue(transaction)) return;

        await db.$transaction(async (tx) => {
          // Create new transaction
          await tx.transaction.create({
            data : {
              type: transaction.type,
              amount: transaction.amount,
              description: `${transaction.description} (Recurring)`,
              date: new Date(),
              category: transaction.category,
              userId: transaction.userId,
              accountId: transaction.accountId,
              isRecurring: false,
            }
          })

          // Update account balance
          const balanceChange = transaction.type === "EXPENSE"
          ? - transaction.amount.toNumber()
          : transaction.amount.toNumber()

          await tx.account.update({
            where: {id : transaction.accountId},
            data: {balance : { increment: balanceChange}},
          })

          // Update the last processed date and nextRecurring date
          await tx.transaction.update({
            where:  { id: transaction.id },
            data: {
              lastProcessed: new Date(),
              nextRecurringDate: calculateNextRecurringDate(
                new Date(),
                transaction.recurringInterval
              )
            }
          })
        })
    })
  }
)

function isTransactionDue(transaction) {
  //If no last Processed date, transaction is due
  if(!transaction.lastProcessed) return true;

  const today = new Date();
  const nextDue = new Date(transaction.nextRecurringDate);

  // Compare with nextDue date
  return nextDue <= today
}

// Calculate next Recurring Date
function calculateNextRecurringDate(startDate, interval) {
  const date = new Date(startDate);

  switch (interval) {
      case "DAILY":
          date.setDate(date.getDate()+1);
          break;
      case "WEEKLY":
          date.setDate(date.getDate()+7);
          break;
      case "MONTHLY":
          date.setMonth(date.getMonth()+1);
          break;
      case "YEARLY":
          date.setFullYear(date.getFullYear()+1);
          break;
  }

  return date;
}