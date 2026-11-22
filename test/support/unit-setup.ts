import { Logger } from '@nestjs/common';

// Unit tests construct services directly, so their `new Logger(...)` calls
// would print to the console; assertions never depend on log output.
Logger.overrideLogger(false);
