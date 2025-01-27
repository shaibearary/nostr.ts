import {
    assertEquals,
    assertInstanceOf,
    assertNotInstanceOf,
    fail,
} from "https://deno.land/std@0.176.0/testing/asserts.ts";
import { NostrKind } from "./nostr.ts";
import { relays } from "./relay-list.test.ts";
import {
    ConnectionPool,
    RelayAlreadyRegistered,
    SingleRelayConnection,
    SubscriptionAlreadyExist,
} from "./relay.ts";
import { AsyncWebSocket, WebSocketClosed } from "./websocket.ts";
import * as csp from "https://raw.githubusercontent.com/BlowaterNostr/csp/master/csp.ts";

Deno.test("ConnectionPool close gracefully 1", async () => {
    const pool = new ConnectionPool();
    await pool.close(); // otherwise the coroutine in the constructor will run forever
});

Deno.test("ConnectionPool close gracefully 2", async () => {
    // able to open & close
    const relay = SingleRelayConnection.New(relays[0], AsyncWebSocket.New);
    if (relay instanceof Error) {
        fail(relay.message);
    }
    await relay.untilOpen();

    const pool = new ConnectionPool();
    const err = await pool.addRelay(relay);
    assertNotInstanceOf(err, Error);
    assertEquals(pool.getClosedRelaysThatShouldBeReconnected().length, 0);
    await relay.close(); // if a relay is closed by us instead of the server,
    //                      the pool should not add it back
    await csp.sleep(300);
    assertEquals(pool.getClosedRelaysThatShouldBeReconnected().length, 0);
    await pool.close();
});

Deno.test("ConnectionPool open multiple relays concurrently & close", async () => {
    const pool = new ConnectionPool();
    const errs = await pool.addRelayURLs(relays);
    if (errs != undefined) {
        assertEquals(errs.length < relays.length / 2, true); // as long as 50%+ relays are available
    }
    await pool.close();
});

Deno.test("ConnectionPool newSub & close", async () => {
    // able to open & close
    const url = relays[0];
    const relay = SingleRelayConnection.New(url, AsyncWebSocket.New);
    if (relay instanceof Error) {
        fail(relay.message);
    }
    const connectionPool = new ConnectionPool();
    {
        const err = await connectionPool.addRelay(relay);
        assertEquals(err, undefined);
    }
    const sub = await connectionPool.newSub("1", { kinds: [0], limit: 1 });
    if (sub instanceof Error) {
        console.log(sub);
        fail();
    }
    await connectionPool.close();
    if (sub instanceof SubscriptionAlreadyExist) {
        fail("unreachable");
    }
    assertEquals(
        sub.chan.closed(),
        "close sub 1 because of pool is closed by the client",
    );
});

Deno.test("ConnectionPool subscription already exist", async () => {
    const pool = new ConnectionPool();
    const subID = "1";
    const chan = await pool.newSub(subID, { kinds: [0], limit: 1 });
    if (chan instanceof Error) {
        fail();
    }
    await pool.closeSub(subID);
    const chan2 = await pool.newSub(subID, { kinds: [0], limit: 1 });
    assertInstanceOf(chan2, SubscriptionAlreadyExist);
    await pool.close();
});

Deno.test("ConnectionPool close subscription", async () => {
    const pool = new ConnectionPool();
    pool.addRelayURL(relays[0]);
    {
        const subID = "x";
        const sub = await pool.newSub(subID, { kinds: [0], limit: 1 });
        assertNotInstanceOf(sub, Error);
        await pool.closeSub(subID);
        // even if the subscription is closed,
        // we don't close the consumer channel
        assertEquals(sub.chan.closed(), false);
        const result = await sub.chan.pop();
        if (result == csp.closed) {
            fail();
        }
        assertEquals(result.res.type, "EVENT");
    }
    await pool.close();
});

Deno.test("ConnectionPool register the same relay twice", async () => {
    const pool = new ConnectionPool();

    const relay = SingleRelayConnection.New(relays[0], AsyncWebSocket.New);
    if (relay instanceof Error) {
        fail(relay.message);
    }

    const err1 = await pool.addRelay(relay);
    assertEquals(err1, undefined);

    const err2 = await pool.addRelay(relay);
    assertInstanceOf(err2, RelayAlreadyRegistered);

    await pool.close();
});

Deno.test("ConnectionPool able to subscribe before adding relays", async () => {
    const pool = new ConnectionPool();

    const chan = await pool.newSub("1", {
        kinds: [NostrKind.DELETE],
        limit: 1,
    });
    if (chan instanceof Error) {
        fail(chan.message);
    }

    const relay = SingleRelayConnection.New(relays[0], AsyncWebSocket.New);
    if (relay instanceof Error) {
        fail(relay.message);
    }

    const err1 = await pool.addRelay(relay);
    assertEquals(err1, undefined);

    const msg = await chan.chan.pop();
    if (msg === csp.closed) {
        fail();
    }
    // don't care the value, just need to make sure that it's from the same relay
    assertEquals(msg.url, relays[0]);
    await pool.close();
});

Deno.test("newSub 2 times & add relay url later", async (t) => {
    const pool = new ConnectionPool({ ws: AsyncWebSocket.New });
    {
        const stream1 = await pool.newSub("sub1", {
            kinds: [NostrKind.META_DATA],
            limit: 1,
        });
        if (stream1 instanceof Error) {
            fail(stream1.message);
        }
        const stream2 = await pool.newSub("sub2", {
            kinds: [NostrKind.CustomAppData],
            limit: 1,
        });
        if (stream2 instanceof Error) {
            fail(stream2.message);
        }

        // add relay after creating subscriptions
        // should not create starvation for readers
        await pool.addRelayURL(relays[1]);

        const res1 = await stream1.chan.pop();
        const res2 = await stream1.chan.pop();
        const res3 = await stream2.chan.pop();
        const res4 = await stream2.chan.pop();
        // as long as it does not block
    }
    await pool.close();
});

Deno.test("websocket offline", async () => {
    // a host that can not be reached / not exist
    let pool = new ConnectionPool();
    let relay = SingleRelayConnection.New(
        "wss://relay0.damus.io", // does not exist
        AsyncWebSocket.New,
    );
    if (relay instanceof Error) {
        fail();
    }
    let err = await pool.addRelay(relay);
    assertInstanceOf(err, WebSocketClosed);
    assertEquals(pool.getRelays().length, 0);
    await pool.close();
});
