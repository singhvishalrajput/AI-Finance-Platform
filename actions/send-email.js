import { Resend } from "resend";

export async function sendEmail({to, subject, react}){
    const resend = new Resend(process.env.RESEND_API_KEY);
    console.log(process.env.RESEND_API_KEY)
    try {

        const data = await resend.emails.send({
            from: "Finance App <onboarding@resend.dev>",
            to,
            subject,
            react,
        })

        console.log(data)

        return {success: true, data}
        
    } catch (error) {
          console.log("Failed to send email:", error);
          
          return {success:false, error} 
    }
}