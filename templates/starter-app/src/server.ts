import { createApplication } from "./app.ts";

const application = createApplication();
application.server.listen(Number(process.env.PORT ?? 4300), "0.0.0.0");
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void application.close();
  });
