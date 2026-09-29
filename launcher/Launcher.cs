using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;

class Launcher
{
    static string dir;
    static Process app;

    static int Run(string cmd, bool wait = true)
    {
        var psi = new ProcessStartInfo("cmd.exe", "/c " + cmd) { WorkingDirectory = dir, UseShellExecute = false };
        var p = Process.Start(psi);
        if (!wait) { app = p; return 0; }
        p.WaitForExit();
        return p.ExitCode;
    }

    static void KillTree()
    {
        if (app == null || app.HasExited) return;
        try { Process.Start(new ProcessStartInfo("taskkill", "/T /F /PID " + app.Id) { UseShellExecute = false, CreateNoWindow = true }).WaitForExit(); } catch { }
    }

    static void Fail(string msg)
    {
        Console.ForegroundColor = ConsoleColor.Red;
        Console.WriteLine("\n" + msg);
        Console.ResetColor();
        Console.WriteLine("Press Enter to close.");
        Console.ReadLine();
        Environment.Exit(1);
    }

    static void Main()
    {
        Console.Title = "AI Overnight Trader";
        dir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        if (!File.Exists(Path.Combine(dir, "package.json")))
            Fail("Put AI-Overnight-Trader.exe in the project folder (next to package.json).");

        Console.WriteLine("AI Overnight Trader");
        Console.WriteLine("-------------------");

        if (Run("node --version >nul 2>&1") != 0)
            Fail("Node.js was not found. Install Node 20+ from https://nodejs.org and try again.");

        var env = Path.Combine(dir, ".env.local");
        if (!File.Exists(env))
        {
            var example = Path.Combine(dir, ".env.example");
            if (File.Exists(example)) File.Copy(example, env);
            Console.WriteLine("Created .env.local. Add your Trading 212 and OpenAI keys to it, then restart.");
            Console.WriteLine("(The app still opens without keys, but the AI can't run.)\n");
        }

        if (!Directory.Exists(Path.Combine(dir, "node_modules")))
        {
            Console.WriteLine("First run: installing dependencies (a few minutes)...");
            if (Run("npm install") != 0) Fail("npm install failed.");
        }
        if (!File.Exists(Path.Combine(dir, ".next", "BUILD_ID")))
        {
            Console.WriteLine("Building the app (about a minute)...");
            if (Run("npm run build") != 0) Fail("Build failed.");
        }

        Console.WriteLine("Starting the dashboard and the trading worker...\n");
        Run("npm run start:prod", false);
        AppDomain.CurrentDomain.ProcessExit += (s, e) => KillTree();
        Console.CancelKeyPress += (s, e) => KillTree();

        for (int i = 0; i < 90 && !app.HasExited; i++)
        {
            try
            {
                var r = (HttpWebRequest)WebRequest.Create("http://localhost:3000/");
                r.Timeout = 1500;
                using (r.GetResponse()) { }
                Process.Start(new ProcessStartInfo("http://localhost:3000") { UseShellExecute = true });
                break;
            }
            catch { Thread.Sleep(1000); }
        }
        Console.WriteLine("\nRunning at http://localhost:3000. Close this window to stop the app and the worker.");
        app.WaitForExit();
        Fail("The app stopped unexpectedly. See the messages above.");
    }
}
