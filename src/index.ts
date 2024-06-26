import { AzureClient, AzureClientProps, } from "@fluidframework/azure-client";
import { InsecureTokenProvider } from "@fluidframework/test-client-utils";
import { SequenceDeltaEvent, SharedString } from "@fluidframework/sequence";
import { SharedMap } from "@fluidframework/map";
import { MergeTreeDeltaType } from "@fluidframework/merge-tree";
import { TaskManager } from "./TaskManager";
import cluster from "node:cluster";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitForPredicate(predicate: () => boolean, ms = 5) {
    while (!predicate()) {
        await sleep(ms);
    }
}

function sendIPCMessage(msg: any) {
    return new Promise<void>((resolve, reject) => {
        if (!process.send) {
            reject(new Error("No IPC channel to parent process."));
            return;
        }
        process.send(msg, undefined, undefined, (error: Error|null) => {
            if (error != null) {
                reject(error);
            } else {
                resolve();
            }
        });
    });
}

function createFluidClient() {
    let clientProps: AzureClientProps;
    clientProps = {
        connection: {
            type: "local",
            endpoint: "http://localhost:7070",
            tokenProvider: new InsecureTokenProvider("", { id: "1234", name: "Test User" } as any),
        }
    };
    const fluidClient = new AzureClient(clientProps);
    return fluidClient;
}

type TestConfig = {
    numWorkers: number,
    numOps: number,
    exclusiveInserts: boolean,
};

type WorkerConfig = TestConfig & {
    workerId: number,
    containerId: string,
};

type SequenceEventData = {
    index: number,
    sequenceLength: number,
    value: string,
};

type WorkerResult = {
    workerId: number,
    events: SequenceEventData[],
    sequenceLength: number,
};

const containerSchema = {
    initialObjects: {
        sequence: SharedString,
        taskManager: TaskManager,
        pendingSequenceItems: SharedMap,
    },
};

function getSequenceContent(sequence: SharedString, index: number) {
    return sequence.getPropertiesAtPosition(index)["my_sequence_content"];
}

function sequenceInsert(sequence: SharedString, value: string) {
    const index = sequence.getLength();
    sequence.insertText(index, "x", { "my_sequence_content": value });
}

async function orchestrateTest(config: TestConfig) {
    const client = createFluidClient();
    const { container, services } = await client.createContainer(containerSchema);
    const containerId = await container.attach();

    const workerExitPromiseList: Promise<void>[] = [];
    const workerResults: { [index: number]: WorkerResult } = {};
    for (let n = 0; n < config.numWorkers; ++n) {
        const worker = cluster.fork();
        worker.once("message", result => { workerResults[worker.id] = result; });
        workerExitPromiseList.push(new Promise<void>(resolve => { worker.once("exit", resolve); }));
        const workerConfig: WorkerConfig = {
            numWorkers: config.numWorkers,
            numOps: config.numOps,
            exclusiveInserts: config.exclusiveInserts,
            workerId: worker.id,
            containerId: containerId,
        };
        worker.send(workerConfig);
    }

    console.log("waiting for workers...");
    await Promise.allSettled(workerExitPromiseList);

    Object.entries(workerResults).forEach(([id, result]) => {
        console.log(`Worker ${id}: ${JSON.stringify(result, null, 2)}`);
    });

    const sequence = container.initialObjects?.sequence as SharedString;

    const finalValues = (() => {
        const values: string[] = [];
        for (let i = 0; i < sequence.getLength(); ++i) {
            values.push(getSequenceContent(sequence, i));
        }
        return values;
    })();

    const checkEventValueSequence = (eventValues: string[]) => {
        if (eventValues.length === 0) {
            return true;
        }
        let i = finalValues.indexOf(eventValues[0]);
        for (let j = 0; j < eventValues.length; ++i, ++j) {
            if (eventValues[j] !== finalValues[i]) {
                return false;
            }
        }
        return true;
    };

    console.log("final sequence values");
    console.log(finalValues);
    Object.entries(workerResults).forEach(([id, result]) => {
        const eventValues = result.events.map(e => e.value);
        if (!checkEventValueSequence(eventValues)) {
            console.log(`worker ${result.workerId} event sequence order differs from final sequence`);
            console.log(eventValues);

        }
    });

    container.dispose();
}

async function testWorker() {
    const config = await new Promise<any>(resolve => process.once("message", (msg) => resolve(msg))) as WorkerConfig;
    console.log(`worker [${config.workerId}] started`);

    const client = createFluidClient();
    const { container, services } = await client.getContainer(config.containerId, containerSchema);
    const sequence = container.initialObjects?.sequence as SharedString;
    const pendingSequenceItems = container.initialObjects?.pendingSequenceItems as SharedMap;
    const taskManager = container.initialObjects?.taskManager as TaskManager;

    await waitForPredicate(() => container.connectionState === 2);

    const events: SequenceEventData[] = [];

    sequence.on("sequenceDelta", (event: SequenceDeltaEvent, target: SharedString) => {
        if (event.deltaOperation === MergeTreeDeltaType.INSERT) {
            if (event.ranges.length !== 1) {
                throw new Error("expected only one affected range on insert");
            }
            const r = event.ranges[0];
            const index = r.position;
            const sequenceLength = target.getLength();
            const value = getSequenceContent(sequence, index);
            events.push({ index, sequenceLength, value });
        }
    });

    if (config.exclusiveInserts) {
        const INSERT_TASK = "insert-task-id";
        let insertTaskInterval: ReturnType<typeof setInterval>|undefined = undefined;
        const processPending = () => {
            for (const key of pendingSequenceItems.keys()) {
                if (pendingSequenceItems.get(key) === "pending") {
                    pendingSequenceItems.set(key, "inserted");
                    sequenceInsert(sequence, key);
                }
            }
        };
        const stopInsertTask = () => {
            if (insertTaskInterval) {
                clearInterval(insertTaskInterval);
            }
        };
        const startInsertTask = () => {
            console.log(`worker [${config.workerId}] was assigned to insert`);
            if (insertTaskInterval) {
                stopInsertTask();
            }
            insertTaskInterval = setInterval(() => {
                processPending();
            }, 5);
        };
        taskManager.on("assigned", (taskId) => {
            if (taskId === INSERT_TASK) {
                startInsertTask();
            }
        });
        taskManager.on("lost", (taskId) => {
            if (taskId === INSERT_TASK) {
                stopInsertTask();
            }
        });
        taskManager.subscribeToTask(INSERT_TASK);
    }

    for (let i = 0; i < config.numOps; ++i) {
        const value = `${config.workerId}_${i}`;
        if (config.exclusiveInserts) {
            pendingSequenceItems.set(value, "pending");
        } else {
            sequenceInsert(sequence, value);
        }
        await sleep(5);
    }

    await waitForPredicate(() => sequence.getLength() === config.numWorkers*config.numOps);

    const workerResult: WorkerResult = {
        workerId: config.workerId,
        events: events,
        sequenceLength: sequence.getLength(),
    };
    await sendIPCMessage(workerResult);
    process.disconnect();
}

async function run() {
    const testConfig: TestConfig = {
        numWorkers: 10,
        numOps: 10,
        exclusiveInserts: process.argv[2]  === "no" ? false : true,
    };
    if (cluster.isPrimary) {
        await orchestrateTest(testConfig);
    } else {
        await testWorker();
    }
}

run().catch(console.log);
