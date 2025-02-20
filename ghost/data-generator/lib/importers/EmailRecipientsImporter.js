const TableImporter = require('./TableImporter');
const {faker} = require('@faker-js/faker');
const generateEvents = require('../utils/event-generator');
const dateToDatabaseString = require('../utils/database-date');

const emailStatus = {
    delivered: Symbol(),
    opened: Symbol(),
    failed: Symbol(),
    none: Symbol()
};

class EmailRecipientsImporter extends TableImporter {
    static table = 'email_recipients';
    static dependencies = ['emails', 'email_batches', 'members', 'members_subscribe_events'];

    constructor(knex, transaction) {
        super(EmailRecipientsImporter.table, knex, transaction);
    }

    async import(quantity) {
        const emails = await this.transaction
            .select(
                'id',
                'newsletter_id',
                'email_count',
                'delivered_count',
                'opened_count',
                'failed_count')
            .from('emails');
        this.emails = emails;
        this.emailBatches = await this.transaction.select('id', 'email_id', 'updated_at').from('email_batches');
        this.members = await this.transaction.select('id', 'uuid', 'email', 'name').from('members');
        this.membersSubscribeEvents = await this.transaction.select('id', 'newsletter_id', 'created_at', 'member_id').from('members_subscribe_events');

        await this.importForEach(this.emailBatches, quantity ? quantity / emails.length : 1000);
    }

    setReferencedModel(model) {
        this.batch = model;
        this.model = this.emails.find(email => email.id === this.batch.email_id);
        this.batchIndex = this.emailBatches.filter(b => b.email_id === this.model.id).findIndex(batch => batch.id === this.batch.id);

        // Shallow clone members list so we can shuffle and modify it
        const earliestOpenTime = new Date(this.batch.updated_at);
        const latestOpenTime = new Date(this.batch.updated_at);
        latestOpenTime.setDate(latestOpenTime.getDate() + 14);
        const currentTime = new Date();

        this.membersList = this.membersSubscribeEvents
            .filter(entry => entry.newsletter_id === this.model.newsletter_id)
            .filter(entry => new Date(entry.created_at) < earliestOpenTime)
            .map(memberSubscribeEvent => memberSubscribeEvent.member_id)
            .slice(this.batchIndex * 1000, (this.batchIndex + 1) * 1000);

        this.events = this.membersList.length > 0 ? generateEvents({
            shape: 'ease-out',
            trend: 'negative',
            total: this.membersList.length,
            startTime: earliestOpenTime,
            endTime: currentTime < latestOpenTime ? currentTime : latestOpenTime
        }) : [];

        this.emailMeta = {
            // delievered and not opened
            deliveredCount: this.model.delivered_count - this.model.opened_count,
            openedCount: this.model.opened_count,
            failedCount: this.model.failed_count
        };

        let offset = this.batchIndex * 1000;

        // We always first create the failures, then the opened, then the delivered, so we need to remove those from the meta so we don't generate them multiple times
        this.emailMeta = {
            failedCount: Math.max(0, this.emailMeta.failedCount - offset),
            openedCount: Math.max(0, this.emailMeta.openedCount - Math.max(0, offset - this.emailMeta.failedCount)),
            deliveredCount: Math.max(0, this.emailMeta.deliveredCount - Math.max(0, offset - this.emailMeta.failedCount - this.emailMeta.openedCount))
        };
    }

    generate() {
        const timestamp = this.events.shift();
        if (!timestamp) {
            return;
        }

        const memberIdIndex = faker.datatype.number({
            min: 0,
            max: this.membersList.length - 1
        });
        const [memberId] = this.membersList.splice(memberIdIndex, 1);
        const member = this.members.find(m => m.id === memberId);

        let status = emailStatus.none;
        if (this.emailMeta.failedCount > 0) {
            status = emailStatus.failed;
            this.emailMeta.failedCount -= 1;
        } else if (this.emailMeta.openedCount > 0) {
            status = emailStatus.opened;
            this.emailMeta.openedCount -= 1;
        } else if (this.emailMeta.deliveredCount > 0) {
            status = emailStatus.delivered;
            this.emailMeta.deliveredCount -= 1;
        }

        let deliveredTime;
        if (status === emailStatus.opened) {
            const startDate = new Date(this.batch.updated_at).valueOf();
            const endDate = timestamp.valueOf();
            deliveredTime = new Date(startDate + (Math.random() * (endDate - startDate)));
        }

        return {
            id: faker.database.mongodbObjectId(),
            email_id: this.model.id,
            batch_id: this.batch.id,
            member_id: member.id,
            processed_at: this.batch.updated_at,
            delivered_at: status === emailStatus.opened ? dateToDatabaseString(deliveredTime) : status === emailStatus.delivered ? dateToDatabaseString(timestamp) : null,
            opened_at: status === emailStatus.opened ? dateToDatabaseString(timestamp) : null,
            failed_at: status === emailStatus.failed ? dateToDatabaseString(timestamp) : null,
            member_uuid: member.uuid,
            member_email: member.email,
            member_name: member.name
        };
    }
}

module.exports = EmailRecipientsImporter;
