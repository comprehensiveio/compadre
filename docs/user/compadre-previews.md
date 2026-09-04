# Compadre development previews

Each Compadre development preview has a stable, thread-specific URL. Opening
that URL while its environment is running loads the application immediately.

If the environment has stopped, the same URL shows a startup page while
Compadre restores the thread's saved container and starts its database and
development server. The page reloads automatically when the application is
ready. Multiple open tabs share the same startup operation.

An environment cannot be resumed after its saved checkpoint expires or when it
stopped before creating a checkpoint. In that case, return to the Compadre
thread and ask the agent to rebuild the development environment.
